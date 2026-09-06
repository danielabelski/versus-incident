import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

test.describe("Kubernetes overview", () => {
  test.skip(process.env.E2E_KUBERNETES_BACKEND !== "fake", "requires a fresh Versus backend connected to the deterministic fake Kubernetes API");

  test("shows bounded partial cluster evidence and workload filters", async ({ page }) => {
    await openApp(page, "/agent/tools");
    const kubernetesCard = page.locator("article").filter({ has: page.getByRole("heading", { name: "Kubernetes" }) });
    await expect(kubernetesCard.getByRole("link", { name: "Open Kubernetes" })).toHaveCount(1);
    await kubernetesCard.getByRole("link", { name: "Open Kubernetes" }).click();
    await expect(page).toHaveURL(/\/agent\/kubernetes$/);
    await expect(page.getByRole("heading", { name: "Kubernetes" })).toBeVisible();
    await expect(page.getByText(/limited-cluster/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh Kubernetes data" })).toBeVisible();
    await expect(page.getByText("Nodes ready 2/3")).toBeVisible();
    await expect(page.getByText(/Metrics available/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Workloads" })).toBeVisible();
    await expect(page.getByText("api", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Unhealthy", { exact: true }).first()).toBeVisible();
    const nodes = page.getByRole("region", { name: "Nodes" });
    await nodes.getByRole("button", { name: "View pods on node-a" }).click();
    await expect(nodes.getByRole("list", { name: "Pods on node-a" })).toContainText("payments");
    await expect(nodes.getByRole("list", { name: "Pods on node-a" })).toContainText("api");
    await nodes.getByRole("button", { name: "All nodes" }).click();
    await expect(page.getByText("Topology", { exact: true })).toHaveCount(0);
    await page.getByLabel("Workload namespace").selectOption("payments");
    await page.getByLabel("Resource name").fill("api");
    const workloads = page.getByRole("region", { name: "Workloads" });
    const podResult = workloads.getByRole("button", { name: "Select Pod payments/api", exact: true });
    await expect(podResult).toBeVisible();
    await podResult.click();
    const resourceDetail = page.getByRole("dialog", { name: "Details panel" });
    await expect(resourceDetail).toBeVisible();
    await expect(resourceDetail.getByRole("heading", { name: "Pod · payments/api" })).toBeVisible();
    await expect(resourceDetail.getByText("restart count", { exact: true }).locator("..")).toContainText("1");
    await expect(resourceDetail.getByText("Events", { exact: true }).locator("..")).toContainText("2");
    await expect(page.getByText(/secret-token/)).toHaveCount(0);

    const logs = await page.evaluate(async () => {
      const response = await fetch("/api/admin/kubernetes/pods/payments/api/logs?container=api&tail_lines=20");
      return response.json() as Promise<{ text: string }>;
    });
    expect(logs.text).not.toContain("super-secret-value");
    expect(logs.text).toContain("REDACTED");

    const projections = await page.evaluate(async () => {
      const [secret, configMap] = await Promise.all([
        fetch("/api/admin/kubernetes/resources/core~v1~secrets/api-secret/describe?namespace=payments").then((response) => response.text()),
        fetch("/api/admin/kubernetes/resources/core~v1~configmaps/api-config/describe?namespace=payments").then((response) => response.text()),
      ]);
      return { secret, configMap };
    });
    expect(projections.secret).not.toContain("c2VjcmV0LXRva2Vu");
    expect(projections.secret).toContain("token");
    expect(projections.configMap).not.toContain("must-not-cross");
    expect(projections.configMap).toContain("config.yaml");

  });

  test("remains coherent on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, "/agent/kubernetes");
    await expect(page.getByRole("heading", { name: "Kubernetes" })).toBeVisible();
    const main = await page.locator("main").boundingBox();
    expect(main?.width).toBeLessThanOrEqual(390);
    await expect(page.getByRole("region", { name: "Nodes" })).toBeVisible();
    const overlaps = await page.locator("main button, main input, main select, main [role=listitem]").evaluateAll((elements) => {
      const boxes = elements.map((element) => element.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
      return boxes.some((box) => box.left < 0 || box.right > document.documentElement.clientWidth + 1);
    });
    expect(overlaps).toBe(false);
    const layout = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("#main")!;
      main.focus();
      return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, outline: getComputedStyle(main).outlineStyle };
    });
    expect(layout).toEqual({ overflow: false, outline: "none" });
  });
});