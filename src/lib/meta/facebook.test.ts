import { beforeEach, describe, expect, it, vi } from "vitest";

const { metaGraphFetch } = vi.hoisted(() => ({ metaGraphFetch: vi.fn() }));

vi.mock("./client", () => ({ metaGraphFetch }));

import { getVideoPermalink, publishPageVideo, verifyPublishedVideo } from "./facebook";

describe("Facebook response validation", () => {
  beforeEach(() => metaGraphFetch.mockReset());

  it("rejects a successful publish envelope without a durable id", async () => {
    metaGraphFetch.mockResolvedValueOnce({});
    await expect(
      publishPageVideo({ pageId: "page", videoUrl: "https://video.test", caption: "copy" }),
    ).rejects.toThrow("no usable id");
  });

  it("keeps only safe Facebook permalinks", async () => {
    metaGraphFetch.mockResolvedValueOnce({ id: "post", permalink_url: "https://evil.example/post" });
    await expect(getVideoPermalink("post")).resolves.toBeUndefined();
    metaGraphFetch.mockResolvedValueOnce({
      id: "post",
      permalink_url: "https://www.facebook.com/watch/?v=123",
    });
    await expect(getVideoPermalink("post")).resolves.toBe(
      "https://www.facebook.com/watch/?v=123",
    );
  });

  it("strictly verifies a manually supplied video id against Graph", async () => {
    metaGraphFetch.mockResolvedValueOnce({
      id: "123",
      permalink_url: "https://www.facebook.com/watch/?v=123",
      from: { id: "page" },
    });
    await expect(verifyPublishedVideo("123", "page")).resolves.toBe(
      "https://www.facebook.com/watch/?v=123",
    );

    metaGraphFetch.mockResolvedValueOnce({
      id: "456",
      permalink_url: "https://www.facebook.com/watch/?v=123",
      from: { id: "page" },
    });
    await expect(verifyPublishedVideo("123", "page")).rejects.toThrow("different id");

    metaGraphFetch.mockResolvedValueOnce({
      id: "123",
      permalink_url: "https://www.facebook.com/watch/?v=123",
      from: { id: "another-page" },
    });
    await expect(verifyPublishedVideo("123", "page")).rejects.toThrow("different Page owner");
  });
});
