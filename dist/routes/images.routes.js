"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.imagesRouter = void 0;
const express_1 = require("express");
const upload_1 = require("../middleware/upload");
const images_controller_1 = require("../controllers/images.controller");
exports.imagesRouter = (0, express_1.Router)();
// order matters: static/prefixed routes before the generic /:id route
exports.imagesRouter.post("/", upload_1.upload.single("image"), asyncHandler(images_controller_1.uploadImage));
exports.imagesRouter.get("/", asyncHandler(images_controller_1.listImages));
exports.imagesRouter.get("/:id/status", asyncHandler(images_controller_1.getStatus));
exports.imagesRouter.get("/:id/results", asyncHandler(images_controller_1.getResults));
exports.imagesRouter.get("/:id", asyncHandler(images_controller_1.getImage));
// small helper so controllers can be plain async functions without every
// one of them needing its own try/catch -> next(err) boilerplate
function asyncHandler(fn) {
    return (req, res, next) => fn(req, res, next).catch(next);
}
//# sourceMappingURL=images.routes.js.map