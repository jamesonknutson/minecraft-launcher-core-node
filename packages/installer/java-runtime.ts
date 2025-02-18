import { getPlatform, Platform } from "@xmcl/core";
import { Task, task } from "@xmcl/task";
import { join } from "path";
import { URL } from "url";
import { DownloadTask } from "./downloadTask";
import { Agents, withAgents } from "./http/agents";
import { DownloadBaseOptions, DownloadOptions } from "./http/download";
import { fetchJson } from "./http/fetch";
import { ensureDir, link, ParallelTaskOptions } from "./utils";
/**
 * Contain all java runtimes basic info
 */
export interface JavaRuntimes {
    linux: JavaRuntimeTargets
    "linux-i386": JavaRuntimeTargets
    "mac-os": JavaRuntimeTargets
    "windows-x64": JavaRuntimeTargets
    "windows-x86": JavaRuntimeTargets
}

export interface JavaRuntimeTargets {
    "java-runtime-alpha": JavaRuntimeTarget[]
    "jre-legacy": JavaRuntimeTarget[]
    "minecraft-java-exe": JavaRuntimeTarget[]
}

export enum JavaRuntimeTargetType {
    /**
     * The legacy java version
     */
    Legacy = "jre-legacy",
    /**
     * The new java environment, which is the java 16
     */
    Next = "java-runtime-alpha",
    JavaExe = "minecraft-java-exe",
}

/**
 * Represent a java runtime
 */
export interface JavaRuntimeTarget {
    /**
     * Guessing this is the flight of this java runtime
     */
    availability: {
        group: number
        progress: number
    }
    /**
     * The manifest detail of the resource
     */
    manifest: DownloadInfo
    /**
     * The basic version info of the manifest
     */
    version: {
        /**
         * The name of the version. e.g. `8u51`, `12`, `16.0.1.9.1`
         */
        name: string
        /**
         * The date string (UTC)
         */
        released: string
    }
}


export interface Entry {
    type: "file" | "link" | "directory"
}

export interface LinkEntry extends Entry {
    type: "link"
    /**
     * The link target
     */
    target: string
}

export interface DirectoryEntry extends Entry {
    type: "directory"
}

export interface DownloadInfo {
    /**
     * The sha info of the resource
     */
    sha1: string;
    /**
     * The size of the resource
     */
    size: number;
    /**
     * The url to download resource
     */
    url: string;
}

export interface FileEntry extends Entry {
    type: "file";
    executable: boolean;
    downloads: {
        /**
         * The raw format of the file
         */
        raw: DownloadInfo;
        /**
         * The lzma format of the file
         */
        lzma?: DownloadInfo;
    };
}

export type AnyEntry = FileEntry | DirectoryEntry | LinkEntry;

/**
 * Contains info about every files in this java runtime
 */
export interface JavaRuntimeManifest {
    target: JavaRuntimeTargetType;
    /**
     * The files of the java runtime
     */
    files: Record<string, AnyEntry>;

    version: JavaRuntimeTarget["version"];
}

export const DEFAULT_RUNTIME_ALL_URL = "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json"

function normalizeUrls(url: string, fileHost?: string | string[]): string[] {
    if (!fileHost) {
        return [url];
    }
    if (typeof fileHost === "string") {
        const u = new URL(url);
        u.hostname = fileHost;
        return [u.toString(), url];
    }
    return fileHost.map((host) => {
        const u = new URL(url);
        u.hostname = host;
        return u.toString();
    }).concat(url);
}

export interface FetchJavaRuntimeManifestOptions extends DownloadBaseOptions {
    /**
     * The alternative download host for the file
     */
    apiHost?: string | string[];
    /**
     * The url of the all runtime json
     */
    url?: string;
    /**
     * The platform to install. It will be auto-resolved by default.
     * @default getPlatform()
     */
    platform?: Platform;
    /**
     * The install java runtime type
     * @default InstallJavaRuntimeTarget.Next
     */
    target?: JavaRuntimeTargetType;
    /**
     * The index manifest of the java runtime. If this is not presented, it will fetch by platform and all platform url.
     */
    manfiestIndex?: JavaRuntimes;
}

/**
 * Fetch java runtime manifest. It should be able to resolve to your platform, or you can assign the platform.
 *
 * Also, you should assign the target to download, or it will use the latest java 16.
 * @param options The options of fetch runtime manifest
 */
export async function fetchJavaRuntimeManifest(options: FetchJavaRuntimeManifestOptions = {}): Promise<JavaRuntimeManifest> {
    const manifestIndex = options.manfiestIndex ?? await fetchJson(normalizeUrls(options.url ?? DEFAULT_RUNTIME_ALL_URL, options.apiHost)[0]) as JavaRuntimes;
    const platform = options.platform ?? getPlatform();
    const runtimeTarget = options.target ?? JavaRuntimeTargetType.Next;
    const resolveTarget = () => {
        if (platform.name === "windows") {
            if (platform.arch === "x64") {
                return manifestIndex["windows-x64"];
            }
            if (platform.arch === "x86" || platform.arch === "x32") {
                return manifestIndex["windows-x86"];
            }
        }
        if (platform.name === "osx") {
            return manifestIndex["mac-os"];
        }
        if (platform.name === "linux") {
            if (platform.arch === "x86" || platform.arch === "x32") {
                return manifestIndex["linux-i386"];
            }
            if (platform.arch === "x64") {
                return manifestIndex.linux;
            }
        }
        throw new Error("Cannot resolve platform");
    };
    const targets = resolveTarget()[runtimeTarget];
    if (targets && targets.length > 0) {
        const target = targets[0];
        const manifestUrl = normalizeUrls(target.manifest.url, options.apiHost)[0];
        const manifest = await fetchJson(manifestUrl) as JavaRuntimeManifest;
        const result: JavaRuntimeManifest = {
            files: manifest.files,
            target: runtimeTarget,
            version: target.version,
        };
        return result;
    } else {
        throw new Error();
    }
}


export interface InstallJavaRuntimeOptions extends DownloadBaseOptions, ParallelTaskOptions {
    /**
     * The alternative download host for the file
     */
    apiHost?: string | string[];
    /**
     * The destination of this installation
     */
    destination: string;
    /**
     * The actual manfiest to install.
     */
    manifest: JavaRuntimeManifest;
    /**
     * Download lzma compressed version instead of raw version.
     * - If `true`, it will just download lzma file version, you need to decompress by youself!
     * - If `Function`, it will use that function to decompress the file!
     */
    lzma?: boolean | ((compressedFilePath: string, targetPath: string) => Promise<void>)
}

/**
 * Install java runtime from java runtime manifest
 * @param options The options to install java runtime
 */
export function installJavaRuntimesTask(options: InstallJavaRuntimeOptions): Task<void> {
    return task("installJavaRuntime", async function () {
        const destination = options.destination;
        const manifest = options.manifest;
        const decompressFunction = typeof options.lzma === "function" ? options.lzma : undefined
        const downloadLzma = !!options.lzma
        class DownloadAndDecompressTask extends DownloadTask {
            constructor(options: DownloadOptions) {
                super(options)
            }

            async runTask() {
                const result = await super.runTask()
                if (this._total === this._progress) {
                    const dest = this.download.destination.substring(0, this.download.destination.length - 5)
                    await decompressFunction!(this.download.destination, dest)
                }
                return result
            }
        }
        await withAgents(options, (options) => this.all(Object.entries(manifest.files)
            .filter(([file, entry]) => entry.type === "file")
            .map(([file, entry]) => {
                const fEntry = entry as FileEntry;
                const downloadInfo = (downloadLzma && fEntry.downloads.lzma) ? fEntry.downloads.lzma : fEntry.downloads.raw
                const isLzma = downloadInfo == fEntry.downloads.lzma
                const dest = isLzma ? (join(destination, file) + ".lzma") : join(destination, file);
                const urls = normalizeUrls(downloadInfo.url, options.apiHost);
                const downloadOptions: DownloadOptions = {
                    url: urls,
                    validator: {
                        algorithm: "sha1",
                        hash: downloadInfo.sha1,
                    },
                    destination: dest,
                    segmentPolicy: options.segmentPolicy,
                    retryHandler: options.retryHandler,
                    agents: options.agents,
                }
                return isLzma && decompressFunction
                    ? new DownloadAndDecompressTask(downloadOptions).setName("download")
                    : new DownloadTask(downloadOptions).setName("download");
            }), {
            throwErrorImmediately: options.throwErrorImmediately,
            getErrorMessage: (e) => `Fail to install java runtime ${manifest.version.name} on ${manifest.target}`,
        }));
        await Promise.all(Object.entries(manifest.files)
            .filter(([file, entry]) => entry.type !== "file")
            .map(async ([file, entry]) => {
                const dest = join(destination, file);
                if (entry.type === "directory") {
                    await ensureDir(dest);
                } else if (entry.type === "link") {
                    await link(join(destination, entry.target), destination);
                }
            }));
    });
}
