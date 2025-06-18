#!/usr/bin/env node

// Suppress all Node.js warnings (including deprecation)
(process as any).emitWarning = () => { };

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenAI, toFile } from "openai";
import fs from "fs";
import path from "path";
import os from "os";

(async () => {
  const server = new McpServer({
    name: "openai-gpt-image-mcp",
    version: "1.0.0"
  }, {
    capabilities: {
      tools: { listChanged: false }
    }
  });

  // Helper function to get default output directory
  const getDefaultOutputDir = async (): Promise<string> => {
    const homeDir = os.homedir();
    const defaultDir = path.join(homeDir, "Pictures", "gpt-image");
    
    // Ensure the directory exists
    try {
      await fs.promises.mkdir(defaultDir, { recursive: true });
    } catch (error) {
      console.error("Failed to create default directory:", error);
      // Fallback to /tmp if we can't create the default directory
      return process.env.MCP_HF_WORK_DIR || "/tmp";
    }
    
    return defaultDir;
  };

  // Helper function to sanitize filenames
  const sanitizeFilename = (filename: string): string => {
    // Remove any path separators to prevent directory traversal
    let sanitized = filename.replace(/[\/\\]/g, '-');
    
    // Remove other potentially problematic characters
    sanitized = sanitized.replace(/[<>:"|?*\x00-\x1f]/g, '-');
    
    // Remove leading/trailing dots and spaces
    sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, '');
    
    // Limit length to 200 characters (leaving room for extensions and indexes)
    if (sanitized.length > 200) {
      sanitized = sanitized.substring(0, 200);
    }
    
    // If the filename is empty after sanitization, use a default
    if (!sanitized) {
      sanitized = 'image';
    }
    
    return sanitized;
  };

  // Aspect ratio mapping for common ratios
  const aspectRatioMap: Record<string, string> = {
    "1:1": "1024x1024",
    "square": "1024x1024",
    "16:9": "1536x1024",
    "landscape": "1536x1024",
    "9:16": "1024x1536",
    "portrait": "1024x1536",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "4:3": "1024x1024", // closest to square
    "3:4": "1024x1024", // closest to square
  };

  // Helper function to parse size input
  const parseSize = (input: string): string => {
    // If it's already a valid size, return it
    if (["1024x1024", "1536x1024", "1024x1536", "auto"].includes(input)) {
      return input;
    }
    
    // Check if it's an aspect ratio we can map
    const normalizedInput = input.toLowerCase().replace(/\s+/g, "");
    if (aspectRatioMap[normalizedInput]) {
      return aspectRatioMap[normalizedInput];
    }
    
    // Return the original input to let validation handle it
    return input;
  };

  // Zod schema for create-image tool input
  const createImageSchema = z.object({
    prompt: z.string().max(32000),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    model: z.literal("gpt-image-1").default("gpt-image-1"),
    moderation: z.enum(["auto", "low"]).optional(),
    n: z.number().int().min(1).max(10).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(),
    quality: z.enum(["auto", "high", "medium", "low"]).optional(),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).optional().describe("Size of the generated images. Supports exact dimensions (1024x1024, 1536x1024, 1024x1536) or common aspect ratios (1:1, 16:9, 9:16, square, landscape, portrait, 3:2, 2:3, 4:3, 3:4) or 'auto'."),
    user: z.string().optional(),
    output: z.enum(["base64", "file_output"]).default("base64"),
    file_output: z.string().optional().refine(
      (val) => {
        if (!val) return true;
        // Check for Unix/Linux/macOS absolute paths
        if (val.startsWith("/")) return true;
        // Check for Windows absolute paths (C:/, D:\, etc.)
        if (/^[a-zA-Z]:[/\\]/.test(val)) return true;
        return false;
      },
      { message: "file_output must be an absolute path" }
    ).describe("Absolute path to save the image file, including the desired file extension (e.g., /path/to/image.png). If multiple images are generated (n > 1), an index will be appended (e.g., /path/to/image_1.png)."),
    filename: z.string().optional().describe("Optional descriptive filename (without extension) for saving the image. Example: 'cat-playing-football'. The AI should provide a descriptive name based on the prompt. If not provided, a timestamp will be used."),
  }).refine(
    (data) => {
      if (data.output !== "file_output") return true;
      if (typeof data.file_output !== "string") return false;
      // Check for Unix/Linux/macOS absolute paths
      if (data.file_output.startsWith("/")) return true;
      // Check for Windows absolute paths (C:/, D:\, etc.)
      if (/^[a-zA-Z]:[/\\]/.test(data.file_output)) return true;
      return false;
    },
    { message: "file_output must be an absolute path when output is 'file_output'", path: ["file_output"] }
  );

  // Use ._def.schema.shape to get the raw shape for server.tool due to Zod refinements
  server.tool(
    "create-image",
    (createImageSchema as any)._def.schema.shape,
    async (args, _extra) => {
      const openai = new OpenAI();
      // Only allow gpt-image-1
      const {
        prompt,
        background,
        model = "gpt-image-1",
        moderation,
        n,
        output_compression,
        output_format,
        quality,
        size: sizeRaw,
        user,
        output = "base64",
        file_output: file_outputRaw,
        filename,
      } = args;
      const file_output: string | undefined = file_outputRaw;
      
      // Parse size input to handle aspect ratios
      const size = sizeRaw ? parseSize(sizeRaw) : sizeRaw;
      
      // Validate parsed size
      if (size && !["1024x1024", "1536x1024", "1024x1536", "auto"].includes(size)) {
        throw new Error(
          `Invalid size '${sizeRaw}'. Supported sizes: 1024x1024, 1536x1024, 1024x1536, auto. ` +
          `Also accepts aspect ratios: 1:1, 16:9, 9:16, square, landscape, portrait, 3:2, 2:3, 4:3, 3:4.`
        );
      }

      // Enforce: if background is 'transparent', output_format must be 'png' or 'webp'
      if (background === "transparent" && output_format && !["png", "webp"].includes(output_format)) {
        throw new Error("If background is 'transparent', output_format must be 'png' or 'webp'");
      }

      // Only include output_compression if output_format is webp or jpeg
      const imageParams: any = {
        prompt,
        model,
        ...(background ? { background } : {}),
        ...(moderation ? { moderation } : {}),
        ...(n ? { n } : {}),
        ...(output_format ? { output_format } : {}),
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(user ? { user } : {}),
      };
      if (
        typeof output_compression !== "undefined" &&
        output_format &&
        ["webp", "jpeg"].includes(output_format)
      ) {
        imageParams.output_compression = output_compression;
      }

      const result = await openai.images.generate(imageParams);

      // gpt-image-1 always returns base64 images in data[].b64_json
      const images = (result.data ?? []).map((img: any) => ({
        b64: img.b64_json,
        mimeType: output_format === "jpeg" ? "image/jpeg" : output_format === "webp" ? "image/webp" : "image/png",
        ext: output_format === "jpeg" ? "jpg" : output_format === "webp" ? "webp" : "png",
      }));

      // Auto-switch to file_output if total base64 size exceeds 1MB
      const MAX_RESPONSE_SIZE = 1048576; // 1MB
      const totalBase64Size = images.reduce((sum, img) => sum + Buffer.byteLength(img.b64, "base64"), 0);
      let effectiveOutput = output;
      let effectiveFileOutput = file_output;
      if (output === "base64" && totalBase64Size > MAX_RESPONSE_SIZE) {
        effectiveOutput = "file_output";
        if (!file_output) {
          // Use default output directory
          const defaultDir = await getDefaultOutputDir();
          const baseFilename = filename ? sanitizeFilename(filename) : `openai_image_${Date.now()}`;
          effectiveFileOutput = path.join(defaultDir, `${baseFilename}.${images[0]?.ext ?? "png"}`);
        }
      }

      if (effectiveOutput === "file_output") {
        const fs = await import("fs/promises");
        const path = await import("path");
        
        // If no file_output path was specified, use default directory
        if (!effectiveFileOutput) {
          const defaultDir = await getDefaultOutputDir();
          const baseFilename = filename ? sanitizeFilename(filename) : `openai_image_${Date.now()}`;
          effectiveFileOutput = path.join(defaultDir, `${baseFilename}.${images[0]?.ext ?? "png"}`);
        }
        
        // If multiple images, append index to filename
        const basePath = effectiveFileOutput!;
        const responses = [];
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          let filePath = basePath;
          if (images.length > 1) {
            const parsed = path.parse(basePath);
            filePath = path.join(parsed.dir, `${parsed.name}_${i + 1}.${img.ext ?? "png"}`);
          } else {
            // Ensure correct extension
            const parsed = path.parse(basePath);
            filePath = path.join(parsed.dir, `${parsed.name}.${img.ext ?? "png"}`);
          }
          await fs.writeFile(filePath, Buffer.from(img.b64, "base64"));
          responses.push({ type: "text", text: `Image saved to: file://${filePath}` });
        }
        return { content: responses };
      } else {
        // Default: base64
        return {
          content: images.map((img) => ({
            type: "image",
            data: img.b64,
            mimeType: img.mimeType,
          })),
        };
      }
    }
  );

  // Zod schema for edit-image tool input (gpt-image-1 only)
  const absolutePathCheck = (val: string | undefined) => {
    if (!val) return true;
    // Check for Unix/Linux/macOS absolute paths
    if (val.startsWith("/")) return true;
    // Check for Windows absolute paths (C:/, D:\, etc.)
    if (/^[a-zA-Z]:[/\\]/.test(val)) return true;
    return false;
  };
  const base64Check = (val: string | undefined) => !!val && (/^([A-Za-z0-9+/=\r\n]+)$/.test(val) || val.startsWith("data:image/"));
  const imageInputSchema = z.string().refine(
    (val) => absolutePathCheck(val) || base64Check(val),
    { message: "Must be an absolute path or a base64-encoded string (optionally as a data URL)" }
  ).describe("Absolute path to an image file (png, jpg, webp < 25MB) or a base64-encoded image string.");

  // Base schema without refinement for server.tool signature
  const editImageBaseSchema = z.object({
    image: z.string().describe("Absolute image path or base64 string to edit."),
    prompt: z.string().max(32000).describe("A text description of the desired edit. Max 32000 chars."),
    mask: z.string().optional().describe("Optional absolute path or base64 string for a mask image (png < 4MB, same dimensions as the first image). Fully transparent areas indicate where to edit."),
    model: z.literal("gpt-image-1").default("gpt-image-1"),
    n: z.number().int().min(1).max(10).optional().describe("Number of images to generate (1-10)."),
    quality: z.enum(["auto", "high", "medium", "low"]).optional().describe("Quality (high, medium, low) - only for gpt-image-1."),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).optional().describe("Size of the generated images. Supports exact dimensions (1024x1024, 1536x1024, 1024x1536) or common aspect ratios (1:1, 16:9, 9:16, square, landscape, portrait, 3:2, 2:3, 4:3, 3:4) or 'auto'."),
    user: z.string().optional().describe("Optional user identifier for OpenAI monitoring."),
    output: z.enum(["base64", "file_output"]).default("base64").describe("Output format: base64 or file path."),
    file_output: z.string().refine(absolutePathCheck, { message: "Path must be absolute" }).optional()
      .describe("Absolute path to save the output image file, including the desired file extension (e.g., /path/to/image.png). If n > 1, an index is appended."),
    filename: z.string().optional().describe("Optional descriptive filename (without extension) for saving the edited image. Example: 'cat-with-hat'. The AI should provide a descriptive name based on the edit. If not provided, a timestamp will be used."),
  });

  // Full schema with refinement for validation inside the handler
  const editImageSchema = editImageBaseSchema.refine(
    (data) => {
      if (data.output !== "file_output") return true;
      if (typeof data.file_output !== "string") return false;
      return absolutePathCheck(data.file_output);
    },
    { message: "file_output must be an absolute path when output is 'file_output'", path: ["file_output"] }
  );

  // Edit Image Tool (gpt-image-1 only)
  server.tool(
    "edit-image",
    editImageBaseSchema.shape, // <-- Use the base schema shape here
    async (args, _extra) => {
      // Validate arguments using the full schema with refinements
      const validatedArgs = editImageSchema.parse(args);

      // Explicitly validate image and mask inputs here
      if (!absolutePathCheck(validatedArgs.image) && !base64Check(validatedArgs.image)) {
        throw new Error("Invalid 'image' input: Must be an absolute path or a base64-encoded string.");
      }
      if (validatedArgs.mask && !absolutePathCheck(validatedArgs.mask) && !base64Check(validatedArgs.mask)) {
        throw new Error("Invalid 'mask' input: Must be an absolute path or a base64-encoded string.");
      }

      const openai = new OpenAI();
      const {
        image: imageInput,
        prompt,
        mask: maskInput,
        model = "gpt-image-1",
        n,
        quality,
        size: sizeRaw,
        user,
        output = "base64",
        file_output: file_outputRaw,
        filename,
      } = validatedArgs; // <-- Use validatedArgs here
      const file_output: string | undefined = file_outputRaw;
      
      // Parse size input to handle aspect ratios
      const size = sizeRaw ? parseSize(sizeRaw) : sizeRaw;
      
      // Validate parsed size
      if (size && !["1024x1024", "1536x1024", "1024x1536", "auto"].includes(size)) {
        throw new Error(
          `Invalid size '${sizeRaw}'. Supported sizes: 1024x1024, 1536x1024, 1024x1536, auto. ` +
          `Also accepts aspect ratios: 1:1, 16:9, 9:16, square, landscape, portrait, 3:2, 2:3, 4:3, 3:4.`
        );
      }

      // Helper to convert input (path or base64) to toFile
      async function inputToFile(input: string, idx = 0) {
        if (absolutePathCheck(input)) {
          // File path: infer mime type from extension
          const ext = input.split('.').pop()?.toLowerCase();
          let mime = "image/png";
          if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
          else if (ext === "webp") mime = "image/webp";
          else if (ext === "png") mime = "image/png";
          // else default to png
          return await toFile(fs.createReadStream(input), undefined, { type: mime });
        } else {
          // Base64 or data URL
          let base64 = input;
          let mime = "image/png";
          if (input.startsWith("data:image/")) {
            // data URL
            const match = input.match(/^data:(image\/\w+);base64,(.*)$/);
            if (match) {
              mime = match[1];
              base64 = match[2];
            }
          }
          const buffer = Buffer.from(base64, "base64");
          return await toFile(buffer, `input_${idx}.${mime.split("/")[1] || "png"}`, { type: mime });
        }
      }

      // Prepare image input
      const imageFile = await inputToFile(imageInput, 0);

      // Prepare mask input
      const maskFile = maskInput ? await inputToFile(maskInput, 1) : undefined;

      // Construct parameters for OpenAI API
      const editParams: any = {
        image: imageFile,
        prompt,
        model, // Always gpt-image-1
        ...(maskFile ? { mask: maskFile } : {}),
        ...(n ? { n } : {}),
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(user ? { user } : {}),
        // response_format is not applicable for gpt-image-1 (always b64_json)
      };

      const result = await openai.images.edit(editParams);

      // gpt-image-1 always returns base64 images in data[].b64_json
      // We need to determine the output mime type and extension based on input/defaults
      // Since OpenAI doesn't return this for edits, we'll default to png
      const images = (result.data ?? []).map((img: any) => ({
        b64: img.b64_json,
        mimeType: "image/png",
        ext: "png",
      }));

      // Auto-switch to file_output if total base64 size exceeds 1MB
      const MAX_RESPONSE_SIZE = 1048576; // 1MB
      const totalBase64Size = images.reduce((sum, img) => sum + Buffer.byteLength(img.b64, "base64"), 0);
      let effectiveOutput = output;
      let effectiveFileOutput = file_output;
      if (output === "base64" && totalBase64Size > MAX_RESPONSE_SIZE) {
        effectiveOutput = "file_output";
        if (!file_output) {
          // Use default output directory
          const defaultDir = await getDefaultOutputDir();
          const baseFilename = filename ? sanitizeFilename(filename) : `openai_image_edit_${Date.now()}`;
          effectiveFileOutput = path.join(defaultDir, `${baseFilename}.png`);
        }
      }

      if (effectiveOutput === "file_output") {
        // If no file_output path was specified, use default directory
        if (!effectiveFileOutput) {
          const defaultDir = await getDefaultOutputDir();
          const baseFilename = filename ? sanitizeFilename(filename) : `openai_image_edit_${Date.now()}`;
          effectiveFileOutput = path.join(defaultDir, `${baseFilename}.png`);
        }
        // Use fs/promises and path (already imported)
        const basePath = effectiveFileOutput!;
        const responses = [];
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          let filePath = basePath;
          if (images.length > 1) {
            const parsed = path.parse(basePath);
            // Append index before the original extension if it exists, otherwise just append index and .png
            const ext = parsed.ext || `.${img.ext}`;
            filePath = path.join(parsed.dir, `${parsed.name}_${i + 1}${ext}`);
          } else {
            // Ensure the extension from the path is used, or default to .png
            const parsed = path.parse(basePath);
            const ext = parsed.ext || `.${img.ext}`;
            filePath = path.join(parsed.dir, `${parsed.name}${ext}`);
          }
          await fs.promises.writeFile(filePath, Buffer.from(img.b64, "base64"));
          // Workaround: Return file path as text
          responses.push({ type: "text", text: `Image saved to: file://${filePath}` });
        }
        return { content: responses };
      } else {
        // Default: base64
        return {
          content: images.map((img) => ({
            type: "image",
            data: img.b64,
            mimeType: img.mimeType, // Should be image/png
          })),
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
})(); 