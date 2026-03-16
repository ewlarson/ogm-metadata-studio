import { resourceToJson } from "../aardvark/model";
import { queryAllDistributions, queryResources } from "../duckdb/queries";

type DirectoryHandleLike = any;

export interface PublishToRepoResult {
  resourceCount: number;
  distributionCount: number;
  metadataDirName: string;
  resourceFileName: string;
  distributionsFileName: string;
}

async function removeJsonFiles(dirHandle: DirectoryHandleLike): Promise<void> {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file" && entry.name.endsWith(".json")) {
      await dirHandle.removeEntry(entry.name);
      continue;
    }

    if (entry.kind === "directory") {
      await removeJsonFiles(entry);
    }
  }
}

async function removeEmptyDirectories(dirHandle: DirectoryHandleLike): Promise<void> {
  const directoryNames: string[] = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "directory") {
      directoryNames.push(entry.name);
    }
  }

  for (const directoryName of directoryNames) {
    const child = await dirHandle.getDirectoryHandle(directoryName);
    await removeEmptyDirectories(child);

    let isEmpty = true;
    for await (const entry of child.values()) {
      isEmpty = false;
      break;
    }

    if (isEmpty) {
      await dirHandle.removeEntry(directoryName);
    }
  }
}

async function writeTextFile(
  dirHandle: DirectoryHandleLike,
  fileName: string,
  content: string
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
  const metadataDir = await repoRootHandle.getDirectoryHandle("metadata", { create: true });
  const resourceFileName = "resources.json";
  const distributionsFileName = "resource_distributions.json";

  await removeJsonFiles(metadataDir);
  await removeEmptyDirectories(metadataDir);
  await writeTextFile(
    metadataDir,
    resourceFileName,
    JSON.stringify(resources.map((resource) => resourceToJson(resource)), null, 2)
  );
  await writeTextFile(
    metadataDir,
    distributionsFileName,
    JSON.stringify(distributions, null, 2)
  );

  return {
    resourceCount: resources.length,
    distributionCount: distributions.length,
    metadataDirName: metadataDir.name || "metadata",
    resourceFileName,
    distributionsFileName,
  };
}
