// See the docs at https://docs.convex.dev/agents/files
import { createThread, saveMessage } from "@convex-dev/agent";
import { components, internal } from "../_generated/api";
import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { generateImage } from "ai";
import { imageModel } from "../modelsForDemo";
import { getAuthUserId } from "../utils";

export const generate = action({
  args: { prompt: v.string() },
  handler: async (ctx, { prompt }): Promise<{ threadId: string }> => {
    if (!prompt.trim()) throw new Error("Enter an image description");
    const { threadId } = await ctx.runAction(
      internal.files.generateImage.replyWithImage,
      { prompt },
    );
    return { threadId };
  },
});

/**
 * Generating images
 */

// Generate an image and save it in an assistant message
// This differs in that it's saving the file implicitly by passing the bytes in.
// It will save the file and make a fileId automatically when the input file
// is too big (>100k).
export const replyWithImage = internalAction({
  args: {
    prompt: v.string(),
  },
  handler: async (ctx, { prompt }) => {
    const userId = await getAuthUserId(ctx);
    const threadId = await createThread(ctx, components.agent, {
      userId,
      title: "Image for: " + prompt,
    });
    // Save the user message
    await saveMessage(ctx, components.agent, { threadId, prompt });

    // Generate the image
    const { image } = await generateImage({ model: imageModel, prompt });

    // Save the image in an assistant message
    const { message } = await saveMessage(ctx, components.agent, {
      threadId,
      message: {
        role: "assistant",
        content: [
          {
            type: "file",
            // NOTE: passing in the bytes directly!
            // It will be saved automatically in file storage.
            data: image.uint8Array,
            mediaType: image.mediaType,
          },
        ],
      },
      metadata: {
        model: imageModel.modelId,
        provider: imageModel.provider,
      },
    });
    return { threadId, assistantMessage: message };
  },
});
