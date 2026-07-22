import { Router } from "express";
import { upload } from "../middleware/upload";
import { uploadImage, getStatus, getResults, listImages, getImage } from "../controllers/images.controller";

export const imagesRouter = Router();

// order matters: static/prefixed routes before the generic /:id route
imagesRouter.post("/", upload.single("image"), asyncHandler(uploadImage));
imagesRouter.get("/", asyncHandler(listImages));
imagesRouter.get("/:id/status", asyncHandler(getStatus));
imagesRouter.get("/:id/results", asyncHandler(getResults));
imagesRouter.get("/:id", asyncHandler(getImage));

// small helper so controllers can be plain async functions without every
// one of them needing its own try/catch -> next(err) boilerplate
function asyncHandler(fn: (...args: any[]) => Promise<void>) {
  return (req: any, res: any, next: any) => fn(req, res, next).catch(next);
}
