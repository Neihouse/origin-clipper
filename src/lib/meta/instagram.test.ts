import { beforeEach, describe, expect, it, vi } from "vitest";

const { metaGraphFetch } = vi.hoisted(() => ({ metaGraphFetch: vi.fn() }));

vi.mock("./client", () => ({ metaGraphFetch }));

import {
  createReelsContainer,
  getMediaPermalink,
  pollContainerStatus,
  publishContainer,
  verifyPublishedMedia,
} from "./instagram";

describe("Instagram response validation", () => {
  beforeEach(() => metaGraphFetch.mockReset());

  it("rejects successful POST envelopes without a durable id", async () => {
    metaGraphFetch.mockResolvedValueOnce({});
    await expect(
      createReelsContainer({ igUserId: "ig", videoUrl: "https://video.test", caption: "copy" }),
    ).rejects.toThrow("no usable id");

    metaGraphFetch.mockResolvedValueOnce({ id: "" });
    await expect(publishContainer({ igUserId: "ig", containerId: "container" })).rejects.toThrow(
      "no usable id",
    );
  });

  it("rejects unknown container states", async () => {
    metaGraphFetch.mockResolvedValueOnce({ id: "container", status_code: "SURPRISE" });
    await expect(pollContainerStatus("container")).rejects.toThrow("unknown status");
  });

  it("keeps only safe Instagram permalinks", async () => {
    metaGraphFetch.mockResolvedValueOnce({ id: "media", permalink: "javascript:alert(1)" });
    await expect(getMediaPermalink("media")).resolves.toBeUndefined();
    metaGraphFetch.mockResolvedValueOnce({
      id: "media",
      permalink: "https://www.instagram.com/reel/example/",
    });
    await expect(getMediaPermalink("media")).resolves.toBe(
      "https://www.instagram.com/reel/example/",
    );
  });

  it("strictly verifies a manually supplied media id against Graph", async () => {
    metaGraphFetch.mockResolvedValueOnce({
      id: "123",
      permalink: "https://www.instagram.com/reel/example/",
      owner: { id: "ig-user" },
    });
    await expect(verifyPublishedMedia("123", "ig-user")).resolves.toBe(
      "https://www.instagram.com/reel/example/",
    );

    metaGraphFetch.mockResolvedValueOnce({
      id: "456",
      permalink: "https://www.instagram.com/reel/example/",
      owner: { id: "ig-user" },
    });
    await expect(verifyPublishedMedia("123", "ig-user")).rejects.toThrow("different id");

    metaGraphFetch.mockResolvedValueOnce({
      id: "123",
      permalink: "https://www.instagram.com/reel/example/",
      owner: { id: "another-user" },
    });
    await expect(verifyPublishedMedia("123", "ig-user")).rejects.toThrow("different owner");
  });
});
