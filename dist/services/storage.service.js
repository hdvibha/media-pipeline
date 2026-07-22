"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.storageService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const uuid_1 = require("uuid");
const env_1 = require("../config/env");
class LocalDiskStorage {
    baseDir;
    constructor(baseDir) {
        this.baseDir = baseDir;
        fs_1.default.mkdirSync(this.baseDir, { recursive: true });
    }
    async save(originalFilename, buffer) {
        const id = (0, uuid_1.v4)();
        const ext = path_1.default.extname(originalFilename) || ".jpg";
        const filename = `${id}${ext}`;
        const fullPath = path_1.default.join(this.baseDir, filename);
        await fs_1.default.promises.writeFile(fullPath, buffer);
        return { id, storagePath: filename };
    }
    resolvePath(storagePath) {
        return path_1.default.join(this.baseDir, storagePath);
    }
}
exports.storageService = new LocalDiskStorage(path_1.default.resolve(env_1.env.storageDir));
//# sourceMappingURL=storage.service.js.map