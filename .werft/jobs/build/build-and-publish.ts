import * as semver from "semver";
import { exec } from "../../util/shell";
import { Werft } from "../../util/werft";
import { GCLOUD_SERVICE_ACCOUNT_PATH } from "./const";
import { JobConfig } from "./job-config";

export async function buildAndPublish(werft: Werft, jobConfig: JobConfig) {
    const {
        publishRelease,
        dontTest,
        version,
        localAppVersion,
        publishToNpm,
        coverageOutput,
    } = jobConfig;

    const releaseBranch = jobConfig.repository.ref;

    // We set it to false as default and only set it true if the build succeeds.
    werft.rootSpan.setAttributes({ "preview.gitpod_built_successfully": false });

    werft.phase("build", "build running");
    const imageRepo = publishRelease ? "gcr.io/gitpod-io/self-hosted" : "eu.gcr.io/gitpod-core-dev/build";

    exec(
        `LICENCE_HEADER_CHECK_ONLY=true leeway run components:update-license-header || { echo "[build|FAIL] There are some license headers missing. Please run 'leeway run components:update-license-header'."; exit 1; }`,
    );

    exec(
        `leeway build --docker-build-options network=host --werft=true -c remote ${
            dontTest ? "--dont-test" : ""
        } --coverage-output-path=${coverageOutput} --save /tmp/dev.tar.gz -Dversion=${version} -DimageRepoBase=eu.gcr.io/gitpod-core-dev/dev dev:all`,
    );

    if (publishRelease) {
        exec(`gcloud auth activate-service-account --key-file "/mnt/secrets/gcp-sa-release/service-account.json"`);
    }

    const buildArguments = Object.entries({
        version: version,
        removeSources: "false",
        imageRepoBase: imageRepo,
        localAppVersion: localAppVersion,
        SEGMENT_IO_TOKEN: process.env.SEGMENT_IO_TOKEN,
        npmPublishTrigger: publishToNpm ? Date.now().toString() : "false",
    }).map(([key, value]) => `-D${key}=${value}`).join(" ");

    const buildFlags = [
        "--docker-build-options network=host",
        "--werft=true",
        "-c remote",
        dontTest ? "--dont-test" : "",
        `--coverage-output-path=${coverageOutput}`,
    ].filter((value) => value).join(" ");

    await exec(`leeway build ${buildFlags} ${buildArguments}`, { async: true });

    if (jobConfig.withLocalPreview) {
        await exec(`leeway build install/preview:docker ${buildFlags} ${buildArguments}`, { async: true });
    }

    if (publishRelease) {
        try {
            werft.phase("publish", "checking version semver compliance...");
            if (!semver.valid(version)) {
                // make this an explicit error as early as possible. Is required by helm Charts.yaml/version
                throw new Error(
                    `'${version}' is not semver compliant and thus cannot be used for Self-Hosted releases!`,
                );
            }

            werft.phase("publish", `preparing GitHub release files...`);
            const releaseFilesTmpDir = exec("mktemp -d", { silent: true }).stdout.trim();
            const releaseTarName = "release.tar.gz";
            exec(
                `leeway build --docker-build-options network=host --werft=true chart:release-tars -Dversion=${version} -DimageRepoBase=${imageRepo} --save ${releaseFilesTmpDir}/${releaseTarName}`,
            );
            exec(`cd ${releaseFilesTmpDir} && tar xzf ${releaseTarName} && rm -f ${releaseTarName}`);

            werft.phase("publish", `publishing GitHub release ${version}...`);
            const prereleaseFlag = semver.prerelease(version) !== null ? "-prerelease" : "";
            const tag = `v${version}`;
            const description = `Gitpod Self-Hosted ${version}<br/><br/>Docs: https://www.gitpod.io/docs/self-hosted/latest/self-hosted/`;
            exec(
                `github-release ${prereleaseFlag} gitpod-io/gitpod ${tag} ${releaseBranch} '${description}' "${releaseFilesTmpDir}/*"`,
            );

            werft.done("publish");
        } catch (err) {
            werft.fail("publish", err);
        } finally {
            exec(`gcloud auth activate-service-account --key-file "${GCLOUD_SERVICE_ACCOUNT_PATH}"`);
        }
    }

    werft.rootSpan.setAttributes({ "preview.gitpod_built_successfully": true });
}
