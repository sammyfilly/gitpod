/**
 * Copyright (c) 2020 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License.AGPL.txt in the project root for license information.
 */

import * as crypto from "crypto";
import { inject, injectable } from "inversify";
import * as path from "path";

import {
    AdditionalContentContext,
    CommitContext,
    ImageConfigString,
    NamedWorkspaceFeatureFlag,
    ProjectConfig,
    User,
    WithDefaultConfig,
    WorkspaceConfig,
} from "@gitpod/gitpod-protocol";
import { GitpodFileParser } from "@gitpod/gitpod-protocol/lib/gitpod-file-parser";
import { log, LogContext } from "@gitpod/gitpod-protocol/lib/util/logging";

import { TraceContext } from "@gitpod/gitpod-protocol/lib/util/tracing";
import { HostContextProvider } from "../auth/host-context-provider";
import { Config } from "../config";
import { ConfigurationService } from "../config/configuration-service";

const POD_PATH_WORKSPACE_BASE = "/workspace";

@injectable()
export class ConfigProvider {
    constructor(
        @inject(GitpodFileParser) private readonly gitpodParser: GitpodFileParser,
        @inject(HostContextProvider) private readonly hostContextProvider: HostContextProvider,
        @inject(Config) private readonly config: Config,
        @inject(ConfigurationService) private readonly configurationService: ConfigurationService,
    ) {}

    public async fetchConfig(
        ctx: TraceContext,
        user: User,
        commit: CommitContext,
    ): Promise<{ config: WorkspaceConfig; literalConfig?: ProjectConfig }> {
        const span = TraceContext.startSpan("fetchConfig", ctx);
        span.addTags({
            commit,
        });
        const logContext: LogContext = { userId: user.id };
        try {
            let customConfig: WorkspaceConfig | undefined;
            let literalConfig: ProjectConfig | undefined;

            if (!WithDefaultConfig.is(commit)) {
                const cc = await this.fetchCustomConfig(ctx, user, commit);
                if (!!cc) {
                    customConfig = cc.customConfig;
                    literalConfig = cc.literalConfig;
                }
            }

            if (!customConfig) {
                log.debug(logContext, "Config string undefined, using default config", {
                    repoCloneUrl: commit.repository.cloneUrl,
                    revision: commit.revision,
                });
                const config = this.defaultConfig();
                if (!ImageConfigString.is(config.image)) {
                    throw new Error(`Default config must contain a base image!`);
                }
                config._origin = "default";
                return { config, literalConfig };
            }

            const config = customConfig;
            if (!config.image) {
                config.image = this.config.workspaceDefaults.workspaceImage;
            }

            config.vscode = {
                extensions: (config && config.vscode && config.vscode.extensions) || [],
            };
            await this.validateConfig(config, user);

            /**
             * Some feature flags get attached to any workspace they create - others remain specific to the user.
             * Here we attach the workspace-persisted feature flags to the workspace.
             */
            delete config._featureFlags;
            if (!!user.featureFlags) {
                config._featureFlags = (user.featureFlags!.permanentWSFeatureFlags || []).filter(
                    NamedWorkspaceFeatureFlag.isWorkspacePersisted,
                );
            }
            return { config, literalConfig };
        } catch (e) {
            TraceContext.setError({ span }, e);
            throw e;
        } finally {
            span.finish();
        }
    }

    private async fetchCustomConfig(
        ctx: TraceContext,
        user: User,
        commit: CommitContext,
    ): Promise<{ customConfig: WorkspaceConfig; configBasePath: string; literalConfig: ProjectConfig } | undefined> {
        const span = TraceContext.startSpan("fetchCustomConfig", ctx);
        const logContext: LogContext = { userId: user.id };
        let customConfigString: string | undefined;

        try {
            let customConfig: WorkspaceConfig | undefined;
            const configBasePath = "";
            if (AdditionalContentContext.is(commit) && commit.additionalFiles[".gitpod.yml"]) {
                customConfigString = commit.additionalFiles[".gitpod.yml"];
                const parseResult = this.gitpodParser.parse(customConfigString);
                customConfig = parseResult.config;
                customConfig._origin = "additional-content";
                if (parseResult.validationErrors) {
                    const err = new InvalidGitpodYMLError(parseResult.validationErrors);
                    // this is not a system error but a user misconfiguration
                    log.info(logContext, err.message, {
                        repoCloneUrl: commit.repository.cloneUrl,
                        revision: commit.revision,
                        customConfigString,
                    });
                    throw err;
                }
            }
            if (!customConfig) {
                // try and find config file in the context repo or remote in
                const host = commit.repository.host;
                const hostContext = this.hostContextProvider.get(host);
                if (!hostContext || !hostContext.services) {
                    throw new Error(`Cannot fetch config for host: ${host}`);
                }
                const services = hostContext.services;
                const contextRepoConfig = services.fileProvider.getGitpodFileContent(commit, user);
                customConfigString = await contextRepoConfig;
                let origin: WorkspaceConfig["_origin"] = "repo";

                if (!customConfigString) {
                    const inferredConfig = this.configurationService.guessRepositoryConfiguration(
                        { span },
                        user,
                        commit,
                    );
                    // if there's still no configuration, let's infer one
                    customConfigString = await inferredConfig;
                    origin = "derived";
                }

                if (customConfigString) {
                    const parseResult = this.gitpodParser.parse(customConfigString);
                    customConfig = parseResult.config;
                    if (parseResult.validationErrors) {
                        const err = new InvalidGitpodYMLError(parseResult.validationErrors);
                        // this is not a system error but a user misconfiguration
                        log.info(logContext, err.message, {
                            repoCloneUrl: commit.repository.cloneUrl,
                            revision: commit.revision,
                            customConfigString,
                        });
                        throw err;
                    }
                    customConfig._origin = origin;
                }
            }

            if (!customConfig) {
                return undefined;
            }

            return { customConfig, configBasePath, literalConfig: { ".gitpod.yml": customConfigString || "" } };
        } catch (e) {
            TraceContext.setError({ span }, e);
            throw e;
        } finally {
            span.finish();
        }
    }

    public defaultConfig(): WorkspaceConfig {
        return {
            ports: [],
            tasks: [],
            image: this.config.workspaceDefaults.workspaceImage,
            ideCredentials: crypto.randomBytes(32).toString("base64"),
        };
    }

    private async validateConfig(config: WorkspaceConfig, user: User): Promise<void> {
        // Make sure the projectRoot does not leave POD_PATH_WORKSPACE_BASE as that's a common
        // assumption throughout the code (e.g. ws-daemon)
        const checkoutLocation = config.checkoutLocation;
        if (checkoutLocation) {
            const normalizedPath = path.join(POD_PATH_WORKSPACE_BASE, checkoutLocation);
            if (this.leavesWorkspaceBase(normalizedPath)) {
                log.error({ userId: user.id }, `Invalid checkout location. Would end up at ${normalizedPath}`);
                throw new Error(
                    `Checkout location must not leave the ${POD_PATH_WORKSPACE_BASE} folder. Check your .gitpod.yml file.`,
                );
            }
        }

        const workspaceLocation = config.workspaceLocation;
        if (workspaceLocation) {
            const normalizedPath = path.join(POD_PATH_WORKSPACE_BASE, workspaceLocation);
            if (this.leavesWorkspaceBase(normalizedPath)) {
                log.error({ userId: user.id }, `Invalid workspace location. Would end up at ${normalizedPath}`);
                throw new Error(
                    `Workspace location must not leave the ${POD_PATH_WORKSPACE_BASE} folder. Check your .gitpod.yml file.`,
                );
            }
        }
    }

    private leavesWorkspaceBase(normalizedPath: string) {
        const pathSegments = normalizedPath.split(path.sep);
        return normalizedPath.includes("..") || pathSegments.slice(0, 2).join("/") != POD_PATH_WORKSPACE_BASE;
    }
}

export class InvalidGitpodYMLError extends Error {
    public readonly errorType = "invalidGitpodYML";

    constructor(public readonly validationErrors: string[]) {
        super("Invalid gitpod.yml: " + validationErrors.join(","));
    }
}

export namespace InvalidGitpodYMLError {
    export function is(obj: object): obj is InvalidGitpodYMLError {
        return "errorType" in obj && (obj as any).errorType === "invalidGitpodYML" && "validationErrors" in obj;
    }
}
