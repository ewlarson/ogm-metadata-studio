import { generateDistributionsParquet, generateParquet } from "../duckdb/export";
import { queryAllDistributions, queryResources } from "../duckdb/queries";

type DirectoryHandleLike = any;

export interface PublishToRepoResult {
  resourceCount: number;
  distributionCount: number;
  publicDirPath: string;
  resourceFileName: string;
  distributionsFileName: string;
}

async function writeBinaryFile(
  dirHandle: DirectoryHandleLike,
  fileName: string,
  content: Uint8Array
): Promise<void> {
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function publishCurrentDataToRepoRoot(
  repoRootHandle: DirectoryHandleLike
): Promise<PublishToRepoResult> {
  const [resources, distributions] = await Promise.all([
    queryResources(),
    queryAllDistributions(),
  ]);
  const webDir = await repoRootHandle.getDirectoryHandle("web", { create: true });
  const publicDir = await webDir.getDirectoryHandle("public", { create: true });
  const resourceFileName = "resources.parquet";
  const distributionsFileName = "resource_distributions.parquet";

  const [resourceParquet, distributionsParquet] = await Promise.all([
    generateParquet(resources),
    generateDistributionsParquet(),
  ]);

  if (!resourceParquet) {
    throw new Error("Failed to generate resources.parquet.");
  }
  if (!distributionsParquet) {
    throw new Error("Failed to generate resource_distributions.parquet.");
  }

  await writeBinaryFile(publicDir, resourceFileName, resourceParquet);
  await writeBinaryFile(publicDir, distributionsFileName, distributionsParquet);

  return {
    resourceCount: resources.length,
    distributionCount: distributions.length,
    publicDirPath: `${webDir.name || "web"}/${publicDir.name || "public"}`,
    resourceFileName,
    distributionsFileName,
  };
}
