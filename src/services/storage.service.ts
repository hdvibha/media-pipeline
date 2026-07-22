import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { env } from "../config/env";

/**
 * Local-disk storage implementation. Swapped out for S3/GCS in production by
 * implementing the same two methods against a bucket client - the rest of the
 * app only depends on this interface, not on the filesystem directly.
 */
export interface StorageService {
  save(originalFilename: string, buffer: Buffer): Promise<{ id: string; storagePath: string }>;
  resolvePath(storagePath: string): string;
}

class LocalDiskStorage implements StorageService {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  async save(originalFilename: string, buffer: Buffer): Promise<{ id: string; storagePath: string }> {
    const id = uuid();
    const ext = path.extname(originalFilename) || ".jpg";
    const filename = `${id}${ext}`;
    const fullPath = path.join(this.baseDir, filename);
    await fs.promises.writeFile(fullPath, buffer);
    return { id, storagePath: filename };
  }

  resolvePath(storagePath: string): string {
    return path.join(this.baseDir, storagePath);
  }
}

export const storageService: StorageService = new LocalDiskStorage(path.resolve(env.storageDir));
