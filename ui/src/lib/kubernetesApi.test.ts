// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Kubernetes resource API", () => {
  it("lists cluster nodes through the generic resource endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [], truncated: false }), { status: 200 }));

    await api.kubernetesNodes();

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/kubernetes/resources?resource_id=core%7Ev1%7Enodes&limit=100", expect.any(Object));
  });

  it("encodes a selected node in the generic pod field selector", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [], truncated: false }), { status: 200 }));

    await api.kubernetesNodePods("worker/a+b");

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/kubernetes/resources?resource_id=core%7Ev1%7Epods&limit=100&fields=spec.nodeName%3Dworker%2Fa%2Bb", expect.any(Object));
  });

  it("follows Kubernetes continuation pages without exceeding 500 projected rows", async () => {
    const firstItems = Array.from({ length: 100 }, (_, index) => ({ resource_id: "core~v1~nodes", kind: "Node", name: `node-${index}` }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: firstItems, continue: "next-token", truncated: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ resource_id: "core~v1~nodes", kind: "Node", name: "node-100" }], truncated: false }), { status: 200 }));

    const result = await api.kubernetesNodes();

    expect(result.items).toHaveLength(101);
    expect(fetchMock.mock.calls[1][0]).toContain("continue=next-token");
    expect(result.truncated).toBe(false);
  });
});