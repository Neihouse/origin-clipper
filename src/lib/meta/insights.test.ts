import { beforeEach, describe, expect, it, vi } from "vitest";

const { metaGraphFetch } = vi.hoisted(() => ({ metaGraphFetch: vi.fn() }));

vi.mock("./client", () => ({ metaGraphFetch }));

import { getFacebookVideoInsights, getInstagramMediaInsights } from "./insights";

describe("Instagram media insights", () => {
  beforeEach(() => metaGraphFetch.mockReset());

  it("maps present metrics and nulls out metrics Meta omitted", async () => {
    metaGraphFetch.mockResolvedValueOnce({
      data: [
        { name: "views", values: [{ value: 120 }] },
        { name: "reach", values: [{ value: 80 }] },
        { name: "likes", values: [{ value: 12 }] },
        // comments, shares, saved intentionally absent
      ],
    });

    await expect(getInstagramMediaInsights("media-1")).resolves.toEqual({
      views: 120,
      reach: 80,
      likes: 12,
      comments: null,
      shares: null,
      saved: null,
    });
  });

  it("never defaults an absent metric to 0", async () => {
    metaGraphFetch.mockResolvedValueOnce({ data: [] });

    const result = await getInstagramMediaInsights("media-1");
    expect(result.views).toBeNull();
    expect(result.views).not.toBe(0);
  });

  it("requests the current metric names, not the deprecated ones", async () => {
    metaGraphFetch.mockResolvedValueOnce({ data: [] });
    await getInstagramMediaInsights("media-1");

    expect(metaGraphFetch).toHaveBeenCalledWith(
      "/media-1/insights",
      expect.objectContaining({ params: expect.objectContaining({ metric: expect.any(String) }) }),
    );
    const call = metaGraphFetch.mock.calls[0];
    if (!call) throw new Error("expected metaGraphFetch to have been called");
    const params = call[1].params;
    expect(params.metric).toContain("views");
    expect(params.metric).not.toContain("plays");
  });
});

describe("Facebook video insights", () => {
  beforeEach(() => metaGraphFetch.mockReset());

  it("combines the video_insights views metric with direct object engagement fields", async () => {
    // getFacebookVideoInsights fires these two calls concurrently via
    // Promise.all, in this order: /video_insights first, then the direct
    // object-fields call — mockResolvedValueOnce queues resolve values by
    // call order, not by path.
    metaGraphFetch.mockResolvedValueOnce({
      data: [{ name: "total_video_views", values: [{ value: 500 }] }],
    });
    metaGraphFetch.mockResolvedValueOnce({
      id: "video-1",
      reactions: { summary: { total_count: 10 } },
      comments: { summary: { total_count: 3 } },
      shares: { count: 7 },
    });

    await expect(getFacebookVideoInsights("video-1")).resolves.toEqual({
      videoViews: 500,
      reactions: 10,
      comments: 3,
      shares: 7,
    });
  });

  it("nulls out engagement fields Meta omits (e.g. zero shares) instead of assuming 0", async () => {
    metaGraphFetch.mockResolvedValueOnce({
      data: [{ name: "total_video_views", values: [{ value: 500 }] }],
    });
    metaGraphFetch.mockResolvedValueOnce({ id: "video-1" });

    const result = await getFacebookVideoInsights("video-1");
    expect(result.reactions).toBeNull();
    expect(result.comments).toBeNull();
    expect(result.shares).toBeNull();
    expect(result.shares).not.toBe(0);
  });
});
