import { FileMetadata } from "../types";

/**
 * Date a file sorts by. A deleted pending file has no mtime, and its stored
 * date is the time of the last refresh, so it gets none and sorts last.
 */
export function sortDateOf(metadata: FileMetadata): Date | undefined {
  return metadata.isPending && metadata.isDeleted ? undefined : metadata.date;
}
