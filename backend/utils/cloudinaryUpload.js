import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const uploadBufferToCloudinary = (
  buffer,
  folder = "titanium/products",
) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      },
    );

    stream.end(buffer);
  });

export const uploadMediaBufferToCloudinary = (
  buffer,
  {
    folder = "titanium/routines",
    resourceType = "image",
    publicId,
  } = {},
) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        ...(publicId ? { public_id: publicId } : { folder }),
        resource_type: resourceType,
        ...(resourceType === "video" ? { allowed_formats: ["mp4", "webm", "mov"] } : {}),
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      },
    );

    stream.end(buffer);
  });

export const destroyCloudinaryImage = async (publicId) => {
  if (!publicId) return;
  return cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
};

export const destroyCloudinaryVideo = async (publicId) => {
  if (!publicId) return;
  return cloudinary.uploader.destroy(publicId, { resource_type: "video", invalidate: true });
};

export const deleteFromCloudinary = destroyCloudinaryImage;
