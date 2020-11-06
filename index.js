// MIT License - Copyright (c) 2020 Stefan Arentz <stefan@devbots.xyz>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.


const fs = require('fs');
const crypto = require('crypto');

const core = require('@actions/core');
const cache = require('@actions/cache');
const execa = require('execa');


/**
 * Generate a unique key for the cache entry. To avoid conflicts with
 * other actions that may store data in the cache, the key is a combination
 * of the following items:
 *
 *  - our tool name
 *  - the repo name
 *  - a hash of Cartfile.resolved and xcodebuild -version
 *
 * This should be enough to invalidate caches when either dependencies
 * or the Xcode version changes.
 */

const generateCacheKey = async (configuration, skippingSchemes, xcconfig, noUseBinaries) => {
    const resolved = fs.readFileSync("Cartfile.resolved");
    const xcconfigContents = fs.existsSync(xcconfig) ? fs.readFileSync(xcconfig) : '';
    const {stdout} = await execa('xcodebuild', ['-version']);
    const hash = crypto.createHash('sha1').update(resolved+stdout+configuration+xcconfigContents+skippingSchemes+noUseBinaries).digest('hex');
    return `devbotsxyz:carthage:${process.env.GITHUB_REPOSITORY}:${hash}`;
};


/**
 * Restore the cache.
 */

const restoreCache = async (options) => {
    const key = options.cacheKey || await generateCacheKey(options);
    const restoreKeys = options.cacheBuildFiles ? [generateBuildFilesCacheKey()] : null;
    core.info(`Restoring cache with key ${key}`);
    const result = await cache.restoreCache(["Carthage"], key, restoreKeys);
    core.info(`Result of cache.restore is ${result !== undefined}`);
    return result !== undefined;
};


/*
 * Save the cache.
 */

const saveCache = async (options) => {
    try {
        const key = options.cacheKey || await generateCacheKey(options);
        const restoreKeys = options.cacheBuildFiles ? [generateBuildFilesCacheKey()] : null;
        core.info(`Saving cache with key ${key}`);
        await cache.saveCache(["Carthage"], key, restoreKeys);
        return true;
    } catch (error) {
        core.error(`Carthage could not be cached: ${error.message}`);
        return false;
    }
};


/**
 * Generate a key for accessing the previous successful build's internal Carthage build files.
 */

const generateBuildFilesCacheKey = async () => {
    const {stdout} = await execa('xcodebuild', ['-version']);
    const hash = crypto.createHash('sha1').update(stdout).digest('hex');
    return `devbotsxyz:carthage-build-files:${process.env.GITHUB_REPOSITORY}:${hash}`;
};


/**
 * Restore the internal Carthage build files cache.
 */

const restoreBuildFilesCache = async () => {
    const key = await generateBuildFilesCacheKey();
    core.info(`Restoring internal build files cache with key ${key}`);
    const result = await cache.restoreCache([`${process.env.HOME}/Library/Caches/org.carthage.CarthageKit`, `${process.env.HOME}/Library/Caches/carthage`], key);
    core.info(`Result of cache.restore is ${result !== undefined}`);
    return result !== undefined;
};


/*
 * Save the internal Carthage build files cache.
 */

const saveBuildFilesCache = async () => {
    try {
        const key = await generateBuildFilesCacheKey();
        core.info(`Saving internal build files cache with key ${key}`);
        await cache.saveCache([`${process.env.HOME}/Library/Caches/org.carthage.CarthageKit`, `${process.env.HOME}/Library/Caches/carthage`], key + process.env.GITHUB_RUN_ID, key);
        return true;
    } catch (error) {
        core.error(`Carthage could not cache internal build files: ${error.message}`);
        return false;
    }
};

const parseOptions = () => {
    const options = {
        verbose: core.getInput("verbose") === "true",
        noUseBinaries: core.getInput("no-use-binaries") === "true",
        useNetRC: core.getInput("use-netrc") === "true",
        skippingSchemes: core.getInput("skipping-schemes"),
        xcconfig: core.getInput("xcconfig"),
        configuration: core.getInput("configuration"),
        platform: core.getInput("platform"),
        cache: core.getInput("cache") === "true", // TODO cache=true should be a default
        cacheBuildFiles: core.getInput("cache-build-files") === "true",
        cacheKey: core.getInput("cache-key"),
        gitHubToken: core.getInput("github-token", {required: true}), // Not required when using SSH?
    };
    return options;
};


const carthageBootstrap = async ({platform, noUseBinaries, verbose, gitHubToken, useNetRC, xcconfig, skippingSchemes, cacheBuildFiles, configuration}) => {
    let options = [];
    if (platform !== "") {
        options = [...options, "--platform", platform];
    }
    if (verbose) {
        options = [...options, "--verbose"];
    }
    if (noUseBinaries) {
        options = [...options, "--no-use-binaries"];
    }
    if (useNetRC) {
        options = [...options, "--use-netrc"];
        fs.writeFileSync(`${process.env.HOME}/.netrc`, `machine github.com login ${process.env.GITHUB_ACTOR} password ${gitHubToken}`);
    }
    if (xcconfig !== "") {
        process.env["XCODE_XCCONFIG_FILE"] = xcconfig;
    }
    if (cacheBuildFiles) {
        options = [...options, "--cache-builds"];
    }
    if (configuration !== "") {
        options = [...options, "--configuration", configuration];
    }

    core.info(`options ${options.join(" ")}`)

    // this check should be performed after all other options are added
    if (skippingSchemes !== "") {
        const carthage = execa("carthage", ["bootstrap", ...options, "--no-build"],
                               {reject: false, env: {"NSUnbufferedIO": "YES",
                                                     "GITHUB_ACCESS_TOKEN": gitHubToken}});

        var output = '';
        carthage.stdout.on('data', data => { output += data.toString() });
        carthage.stderr.on('data', data => { output += data.toString() });

        let {exitCode} = await carthage;

        if (exitCode != 0) {
            core.info(output);
            throw Error(`Carthage bootstrap failed with exit code ${exitCode}`);
        }

        skippingSchemes.split(",").map(function (x) { return { target: x.split(":")[0], scheme: x.split(":")[1] } }).map(x => {
            const path = `Carthage/Checkouts/${x.target}/${x.target}.xcodeproj/xcshareddata/xcschemes/${x.scheme}.xcscheme`;
            try {
                core.info(`Removing the scheme at ${path}`);
                fs.unlinkSync(path);
            } catch(err) {
                throw Error(`Unable to find matching scheme at ${path}`);
            }
        })
    }

    const carthage = execa("carthage", ["bootstrap", ...options],
                           {reject: false, env: {"NSUnbufferedIO": "YES",
                                                 "GITHUB_ACCESS_TOKEN": gitHubToken}});

    carthage.stdout.pipe(process.stdout);
    carthage.stderr.pipe(process.stderr);

    let {exitCode} = await carthage;
    if (exitCode != 0) {
        throw Error(`Carthage bootstrap failed with exit code ${exitCode}`);
    }
};


const main = async () => {
    // TODO Better to look in PATH
    if (!fs.existsSync("/usr/local/bin/carthage")) {
        core.setFailed(`Cannot find carthage command in /usr/local/bin/carthage.`);
        return;
    }

    if (!fs.existsSync("Cartfile") || !fs.existsSync("Cartfile.resolved")) {
        core.setFailed(`Cannot find Cartfile and Cartfile.resolved in the working directory.`);
        return;
    }

    try {
        const options = parseOptions();

        // If caching is enabled and we have a cached Carthage
        // available for our dependencies then we just restore and be
        // done with it.

        if (options.cache) {
            const restored = await restoreCache(options);
            if (restored) {
                core.info("Restored Carthage from cache");
                // TODO For clarity print all the dependencies and their versions
                return;    
            }
        }

        if (options.cacheBuildFiles) {
            const restored = await restoreBuildFilesCache();
            if (restored) {
                core.info("Restored Carthage build files cache");
            }
        }

        // Either no caching was requested or we had not prior build
        // cached, so we run carthage bootstrap as usual.

        await carthageBootstrap(options);

        // We just built Carthage from scratch. So if caching was
        // requested then let the post script know that it needs to be
        // saved.

        if (options.cache) {
            core.saveState("needsSaveCache", "true");
        }
    } catch (error) {
        core.setFailed(`Carthage bootstrap failed with an unexpected error: ${error.message}`);
    }
};


const post = async () => {
    try {
        const options = parseOptions();

        // If caching is enabled and we built carthage from scratch,
        // then this is where we cache the Carthage folder.

        if (options.cache && core.getState("needsSaveCache") === "true") {
            core.info("Going to save cache");
            const saved = await saveCache(options);
            if (saved) {
                core.info("Saved cache");
            }
        }

        if (options.cacheBuildFiles && core.getState("needsSaveCache") === "true") {
            core.info("Going to save build files cache");
            const saved = await saveBuildFilesCache(options);
            if (saved) {
                core.info("Saved build files cache");
            }
        }
    } catch (error) {
        core.setFailed(`Caching failed with an unexpected error: ${error.message}`);
    }
};


// TODO It is simpler to have two scripts. Less state and confusion.
if (process.env["STATE_runPost"] === "true") {
    post();
} else {
    core.saveState("runPost", true); // TODO This is a weird hack that is totally confusing.
    main();
}
