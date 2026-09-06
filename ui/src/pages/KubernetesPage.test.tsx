// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import { KubernetesPage } from "./KubernetesPage";

vi.mock("@/components/TopBar", () => ({ TopBar: ({ title, actions }: { title: string; actions?: React.ReactNode }) => <header><span>{title}</span>{actions}</header> }));
vi.mock("@/lib/api", async (importActual) => { const actual = await importActual<typeof import("@/lib/api")>(); return { ...actual, api: { ...actual.api, kubernetesOverview: vi.fn(), kubernetesUsage: vi.fn(), kubernetesWorkloads: vi.fn(), kubernetesWorkload: vi.fn(), kubernetesNodes: vi.fn(), kubernetesNodePods: vi.fn(), kubernetesSearch: vi.fn(), kubernetesEvents: vi.fn(), kubernetesDescribe: vi.fn() } }; });

function renderPage() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); return render(<QueryClientProvider client={client}><KubernetesPage /></QueryClientProvider>); }

function capacityCell(panelName: string, label: string) {
	const panel = screen.getByRole("heading", { name: panelName }).closest("section")!;
	return within(panel).getByText(label).closest("div")!;
}

beforeEach(() => {
	vi.mocked(api.kubernetesOverview).mockResolvedValue({ connector: "kubernetes", cluster_id: "production", observed_at: "2026-08-30T12:00:00Z", nodes: 3, ready_nodes: 2, pods: 18, running_pods: 16, namespaces: 5, active_namespaces: 5, workloads: 7, warnings: 2, usage_source: "unavailable", metrics_status: "unavailable", metrics_fresh: false, truncated: false, partial_failures: [{ resource_id: "core~v1~nodes", class: "forbidden" }] });
	vi.mocked(api.kubernetesUsage).mockResolvedValue({ observed_at: "2026-08-30T12:00:00Z", availability: "unavailable", fresh: false, truncated: false });
	vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: [], truncated: false });
	vi.mocked(api.kubernetesWorkload).mockResolvedValue({ resource_id: "core~v1~pods", kind: "Pod", namespace: "default", name: "api", truncated: false });
	vi.mocked(api.kubernetesNodes).mockResolvedValue({ items: [{ resource_id: "core~v1~nodes", kind: "Node", name: "node-a", conditions: [{ type: "Ready", status: "True" }], summary: { allocatable_cpu: "4", allocatable_memory: "8Gi" } }], truncated: false });
	vi.mocked(api.kubernetesNodePods).mockResolvedValue({ items: [{ resource_id: "core~v1~pods", kind: "Pod", namespace: "default", name: "api", summary: { phase: "Running", restart_count: 1, node: "node-a" } }], truncated: false });
	vi.mocked(api.kubernetesSearch).mockResolvedValue({ items: [], truncated: false });
	vi.mocked(api.kubernetesEvents).mockResolvedValue({ items: [], truncated: false });
	vi.mocked(api.kubernetesDescribe).mockResolvedValue({ resource: { resource_id: "core~v1~pods", kind: "Pod", namespace: "default", name: "api" } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("KubernetesPage", () => {
	it("renders health, partial visibility, and cluster-scoped nodes", async () => {
		const view = renderPage();
		expect(screen.getByLabelText("Loading Kubernetes overview")).toBeTruthy();
		await screen.findByText(/source unavailable/);
		const nodeCount = screen.getByText("Nodes count unavailable");
		expect(within(nodeCount.closest("article")!).getByText("Unavailable")).toBeTruthy();
		const warningButton = screen.getByRole("button", { name: "1 Kubernetes overview warning" });
		expect(warningButton.getAttribute("aria-describedby")).toBe("kubernetes-overview-warnings");
		expect(screen.getByRole("tooltip").textContent).toContain("Partial cluster visibility: forbidden");
		expect(view.container.querySelector("main")?.className).toContain("overflow-x-hidden");
		expect(screen.queryByText(/kubernetes - production/i)).toBeNull();
		expect(screen.queryByLabelText("Namespace")).toBeNull();
		const nodes = await screen.findByRole("region", { name: "Nodes" });
		expect(within(nodes).getByText("node-a")).toBeTruthy();
		expect(within(nodes).getByText("Ready")).toBeTruthy();
		expect(within(nodes).getByText("4 cores")).toBeTruthy();
		expect(within(nodes).getByText("8 GiB")).toBeTruthy();
		expect(screen.queryByText("Topology")).toBeNull();
		expect(api.kubernetesNodes).toHaveBeenCalledTimes(1);
	});

	it("filters loaded workloads immediately by name and namespace", async () => {
		vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: [
			{ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "payments", name: "checkout-api" },
			{ resource_id: "batch~v1~jobs", kind: "Job", namespace: "platform", name: "nightly-cleanup" },
		], truncated: false });
		renderPage();
		await screen.findByText("checkout-api");
		fireEvent.change(screen.getByLabelText("Resource name"), { target: { value: "nightly" } });
		expect(screen.queryByText("checkout-api")).toBeNull();
		expect(screen.getByText("nightly-cleanup")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Workload namespace"), { target: { value: "payments" } });
		expect(screen.getByText("No matching workloads.")).toBeTruthy();
		expect(api.kubernetesSearch).not.toHaveBeenCalled();
	});

	it("filters loaded workloads by status text", async () => {
		vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: [
			{ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "ready-api", summary: { ready: 2, desired: 2 } },
			{ resource_id: "batch~v1~jobs", kind: "Job", namespace: "default", name: "failed-job", summary: { status: "Failed" } },
		], truncated: false });
		renderPage();
		await screen.findByText("ready-api");
		fireEvent.change(screen.getByLabelText("Resource name"), { target: { value: "failed" } });
		expect(screen.queryByText("ready-api")).toBeNull();
		expect(screen.getByText("failed-job")).toBeTruthy();
	});

	it("renders bounded usage freshness and sample counts", async () => {
		vi.mocked(api.kubernetesUsage).mockResolvedValue({ observed_at: "2026-08-30T12:00:00Z", availability: "stale", fresh: false, pods: [{ kind: "Pod", namespace: "default", name: "api" }], nodes: [{ kind: "Node", name: "node-a" }], truncated: true });
		renderPage();
		expect(await screen.findByText("Usage stale · 1 pod samples · 1 node samples · partial")).toBeTruthy();
	});

	it("formats CPU and memory capacity with explicit human units", async () => {
		vi.mocked(api.kubernetesOverview).mockResolvedValue({ connector: "kubernetes", cluster_id: "production", observed_at: "2026-08-30T12:00:00Z", nodes: 3, ready_nodes: 3, pods: 4, running_pods: 4, namespaces: 2, active_namespaces: 2, workloads: 2, warnings: 0, requested_cpu: "1/2", limited_cpu: "2", allocatable_cpu: "250m", usage_cpu: "1.0004", requested_memory: "1024", limited_memory: "1048576", allocatable_memory: "1Gi", usage_source: "unavailable", metrics_status: "unavailable", metrics_fresh: false, truncated: false });
		renderPage();
		await screen.findByText("250 mCPU");
		expect(screen.getAllByText("500 mCPU").length).toBeGreaterThan(0);
		expect(screen.getByText("2 cores")).toBeTruthy();
		expect(screen.getByText("1 core")).toBeTruthy();
		expect(screen.getByText("250 mCPU")).toBeTruthy();
		expect(screen.getByText("1 KiB")).toBeTruthy();
		expect(screen.getByText("1 MiB")).toBeTruthy();
		expect(screen.getByText("1 GiB")).toBeTruthy();
	});

	it("shows pod count and running ratio as unavailable when pod collection is partial", async () => {
		vi.mocked(api.kubernetesOverview).mockResolvedValue({ connector: "kubernetes", cluster_id: "production", observed_at: "2026-08-30T12:00:00Z", nodes: 3, ready_nodes: 3, pods: 0, running_pods: 0, namespaces: 2, active_namespaces: 2, workloads: 2, warnings: 0, requested_cpu: "1", limited_cpu: "2", allocatable_cpu: "4", usage_cpu: "500m", requested_memory: "1Gi", limited_memory: "2Gi", allocatable_memory: "8Gi", usage_memory: "512Mi", usage_source: "metrics_api", metrics_status: "available", metrics_fresh: true, truncated: true, omitted_categories: ["core~v1~pods"], partial_failures: [{ resource_id: "core~v1~pods", class: "response_too_large" }] });
		renderPage();
		const podCount = await screen.findByText("Pods count unavailable");
		expect(within(podCount.closest("article")!).getByText("Unavailable")).toBeTruthy();
		expect(screen.queryByText("Pods running 0/0")).toBeNull();
		expect(within(capacityCell("CPU capacity", "Requested")).getByText("Unavailable")).toBeTruthy();
		expect(within(capacityCell("CPU capacity", "Limited")).getByText("Unavailable")).toBeTruthy();
		expect(within(capacityCell("CPU capacity", "Allocatable")).getByText("4 cores")).toBeTruthy();
		expect(within(capacityCell("CPU capacity", "Usage")).getByText("500 mCPU")).toBeTruthy();
		expect(within(capacityCell("Memory capacity", "Requested")).getByText("Unavailable")).toBeTruthy();
		expect(within(capacityCell("Memory capacity", "Limited")).getByText("Unavailable")).toBeTruthy();
		expect(within(capacityCell("Memory capacity", "Allocatable")).getByText("8 GiB")).toBeTruthy();
		expect(within(capacityCell("Memory capacity", "Usage")).getByText("512 MiB")).toBeTruthy();
	});

	it("masks node-owned capacity when node collection fails", async () => {
		vi.mocked(api.kubernetesOverview).mockResolvedValue({ connector: "kubernetes", cluster_id: "production", observed_at: "2026-08-30T12:00:00Z", nodes: 1, ready_nodes: 1, pods: 2, running_pods: 2, namespaces: 1, active_namespaces: 1, workloads: 1, warnings: 0, requested_cpu: "1", limited_cpu: "2", allocatable_cpu: "4", usage_cpu: "500m", requested_memory: "1Gi", limited_memory: "2Gi", allocatable_memory: "8Gi", usage_memory: "512Mi", usage_source: "metrics_api", metrics_status: "available", metrics_fresh: true, truncated: false, partial_failures: [{ resource_id: "core~v1~nodes", class: "forbidden" }] });
		renderPage();
		const nodeCount = await screen.findByText("Nodes count unavailable");
		expect(within(nodeCount.closest("article")!).getByText("Unavailable")).toBeTruthy();
		expect(within(capacityCell("CPU capacity", "Requested")).getByText("1 core")).toBeTruthy();
		expect(within(capacityCell("CPU capacity", "Allocatable")).getByText("Unavailable")).toBeTruthy();
		expect(within(capacityCell("CPU capacity", "Usage")).getByText("500 mCPU")).toBeTruthy();
		expect(within(capacityCell("Memory capacity", "Requested")).getByText("1 GiB")).toBeTruthy();
		expect(within(capacityCell("Memory capacity", "Allocatable")).getByText("Unavailable")).toBeTruthy();
		expect(within(capacityCell("Memory capacity", "Usage")).getByText("512 MiB")).toBeTruthy();
	});

	it("shows the workload count as unavailable when any workload category is omitted", async () => {
		vi.mocked(api.kubernetesOverview).mockResolvedValue({ connector: "kubernetes", cluster_id: "production", observed_at: "2026-08-30T12:00:00Z", nodes: 3, ready_nodes: 3, pods: 4, running_pods: 4, namespaces: 2, active_namespaces: 2, workloads: 6, warnings: 0, usage_source: "unavailable", metrics_status: "unavailable", metrics_fresh: false, truncated: true, omitted_categories: ["batch~v1~cronjobs"] });
		renderPage();
		const workloadCount = await screen.findByText("Workloads count unavailable");
		expect(within(workloadCount.closest("article")!).getByText("Unavailable")).toBeTruthy();
		expect(screen.queryByText("discovered resources")).toBeNull();
	});

	it("filters workload kinds before pagination and resets to the first page", async () => {
		vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: [...Array.from({ length: 21 }, (_, index) => ({ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: `deployment-${index + 1}` })), { resource_id: "batch~v1~jobs", kind: "Job", namespace: "default", name: "nightly" }], truncated: false });
		renderPage();
		await screen.findByText("deployment-1");
		const workloads = screen.getByRole("region", { name: "Workloads" });
		fireEvent.click(within(workloads).getByRole("button", { name: "Next page" }));
		expect(await within(workloads).findByText("nightly")).toBeTruthy();
		fireEvent.click(within(workloads).getByRole("tab", { name: "Deployment" }));
		expect(await within(workloads).findByText("deployment-1")).toBeTruthy();
		expect(within(workloads).queryByText("deployment-21")).toBeNull();
		fireEvent.click(within(workloads).getByRole("tab", { name: "Job" }));
		expect(await within(workloads).findByText("nightly")).toBeTruthy();
		expect(within(workloads).queryByRole("button", { name: "Next page" })).toBeNull();
	});

	it("paginates workloads, warnings, and nodes at 20 rows", async () => {
		vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: Array.from({ length: 21 }, (_, index) => ({ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: `workload-${index + 1}`, summary: { readyReplicas: 1, replicas: 1 } })), truncated: false });
		vi.mocked(api.kubernetesEvents).mockResolvedValue({ items: Array.from({ length: 21 }, (_, index) => ({ resource_id: "core~v1~events", kind: "Event", namespace: "default", name: `event-${index + 1}`, summary: { reason: `Warning ${index + 1}`, involved_object: { kind: "Pod", namespace: "default", name: `pod-${index + 1}` } } })), truncated: false });
		vi.mocked(api.kubernetesNodes).mockResolvedValue({ items: Array.from({ length: 21 }, (_, index) => ({ resource_id: "core~v1~nodes", kind: "Node", name: `node-${String(index + 1).padStart(2, "0")}`, conditions: [{ type: "Ready", status: "True" }] })), truncated: false });
		renderPage();
		await screen.findByText("workload-20");
		const workloads = screen.getByRole("region", { name: "Workloads" });
		expect(within(workloads).getByText("workload-20")).toBeTruthy();
		expect(within(workloads).queryByText("workload-21")).toBeNull();
		fireEvent.click(within(workloads).getByRole("button", { name: "Next page" }));
		expect(await within(workloads).findByText("workload-21")).toBeTruthy();

		const warnings = screen.getByRole("region", { name: "Recent warnings" });
		expect(within(warnings).queryByText("Warning 21")).toBeNull();
		fireEvent.click(within(warnings).getByRole("button", { name: "Next page" }));
		expect(await within(warnings).findByText("Warning 21")).toBeTruthy();

		const nodes = screen.getByRole("region", { name: "Nodes" });
		expect(within(nodes).getByRole("button", { name: "View pods on node-20" })).toBeTruthy();
		expect(within(nodes).queryByRole("button", { name: "View pods on node-21" })).toBeNull();
		fireEvent.click(within(nodes).getByRole("button", { name: "Next page" }));
		expect(await within(nodes).findByRole("button", { name: "View pods on node-21" })).toBeTruthy();
	});

	it("shows and paginates all namespaces of pods for a selected node", async () => {
		vi.mocked(api.kubernetesNodePods).mockResolvedValue({ items: Array.from({ length: 21 }, (_, index) => ({ resource_id: "core~v1~pods", kind: "Pod", namespace: index % 2 ? "payments" : "platform", name: `pod-${index + 1}`, summary: { phase: index === 0 ? "Pending" : "Running", restart_count: index } })), truncated: true, partial_failures: [{ class: "response_too_large" }] });
		renderPage();
		const nodes = screen.getByRole("region", { name: "Nodes" });
		fireEvent.click(await within(nodes).findByRole("button", { name: "View pods on node-a" }));
		await waitFor(() => expect(api.kubernetesNodePods).toHaveBeenCalledWith("node-a"));
		expect((await within(nodes).findAllByText("platform")).length).toBeGreaterThan(0);
		expect(within(nodes).getAllByText("payments").length).toBeGreaterThan(0);
		expect(within(nodes).queryByText("pod-21")).toBeNull();
		fireEvent.click(within(nodes).getByRole("button", { name: "Next page" }));
		expect(await within(nodes).findByText("pod-21")).toBeTruthy();
		expect(within(nodes).getByText(/Scheduled pod inventory is partial/)).toBeTruthy();
		fireEvent.click(within(nodes).getByRole("button", { name: "All nodes" }));
		expect(within(nodes).getByRole("button", { name: "View pods on node-a" })).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Workload namespace"), { target: { value: "All" } });
		expect(api.kubernetesUsage).toHaveBeenCalledTimes(1);
		expect(api.kubernetesNodes).toHaveBeenCalledTimes(1);
	});

	it("expands warning details from the safe event projection", async () => {
		vi.mocked(api.kubernetesEvents).mockResolvedValue({ items: [{ resource_id: "core~v1~events", kind: "Event", namespace: "payments", name: "mount-warning", summary: { reason: "FailedMount", message: "Unable to attach the projected volume.", involved_object: { kind: "Deployment", namespace: "payments", name: "checkout" }, count: 4, action: "MountVolume", firstTimestamp: "2026-08-30T11:00:00Z", lastTimestamp: "2026-08-30T12:00:00Z" } }], truncated: false });
		renderPage();
		const warning = await screen.findByRole("button", { name: /FailedMount/ });
		expect(warning.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Unable to attach the projected volume.")).toBeNull();
		fireEvent.click(warning);
		expect(await screen.findByText("Unable to attach the projected volume.")).toBeTruthy();
		expect(screen.getByText("MountVolume")).toBeTruthy();
		expect(screen.getByText("checkout")).toBeTruthy();
		expect(warning.getAttribute("aria-expanded")).toBe("true");
	});

	it("shows normalized current workload metrics and related pod status", async () => {
		vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: [{ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout", conditions: [{ type: "Ready", status: "True" }] }], truncated: false });
		vi.mocked(api.kubernetesDescribe).mockResolvedValue({ resource: { resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout", summary: { desired: 1, ready: 1, updateStrategy: "RollingUpdate", serviceType: "ClusterIP" } } });
		vi.mocked(api.kubernetesWorkload).mockResolvedValue({ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout", desired: 1, ready: 1, update_strategy: "RollingUpdate", containers: [{ name: "app", limits: { cpu: "750m", memory: "768Mi" } }, { name: "sidecar", limits: { cpu: "250m", memory: "256Mi" } }], usage: [{ kind: "Pod", namespace: "default", name: "checkout-abc", cpu: "1/2", memory: "1073741824", timestamp: "2026-08-30T12:00:00Z" }], pods: [{ name: "checkout-abc", phase: "Running", node: "node-a", restart_count: 2 }], truncated: false });
		renderPage();
		await screen.findByText("checkout");
		fireEvent.click(screen.getByRole("button", { name: "Select Deployment default/checkout" }));
		const metrics = await screen.findByRole("region", { name: /Current workload metrics snapshot/ });
		expect(within(metrics).getByText("Current metrics snapshot")).toBeTruthy();
		expect(metrics.getAttribute("aria-label")).toMatch(/CPU normalized against configured per-pod limits; memory normalized against configured per-pod limits/i);
		expect(within(metrics).queryByText(/CPU normalized/i)).toBeNull();
		expect(within(metrics).getByText("500 mCPU")).toBeTruthy();
		expect(within(metrics).getByText("1 GiB")).toBeTruthy();
		const cpu = within(metrics).getByRole("progressbar", { name: "checkout-abc cpu usage" });
		expect(cpu.getAttribute("aria-valuemax")).toBe("1");
		expect(cpu.getAttribute("aria-valuetext")).toBe("500 mCPU");
		expect(within(metrics).getByRole("progressbar", { name: "checkout-abc memory usage" }).getAttribute("aria-valuetext")).toBe("1 GiB");
		const pods = screen.getByRole("region", { name: "Related pods" });
		expect(within(pods).getByText("Running")).toBeTruthy();
		expect(within(pods).getByText("node-a")).toBeTruthy();
		expect(within(pods).getByText("Pod").closest("div.mt-3")?.getAttribute("tabindex")).toBe("0");
		const detail = screen.getByRole("dialog", { name: "Details panel" });
		expect(within(detail).getByText("Kind").closest("dl")).toBeTruthy();
		expect(within(detail).queryByText("update strategy")).toBeNull();
		expect(within(detail).getByText("service type")).toBeTruthy();
	});

	it("labels within-workload metric fallback when container limits are incomplete", async () => {
		vi.mocked(api.kubernetesOverview).mockResolvedValue({ connector: "kubernetes", cluster_id: "production", observed_at: "2026-08-30T12:00:00Z", nodes: 1, ready_nodes: 1, pods: 1, running_pods: 1, namespaces: 1, active_namespaces: 1, workloads: 1, warnings: 0, usage_source: "metrics_api", metrics_status: "available", metrics_fresh: true, truncated: false });
		vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: [{ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout" }], truncated: false });
		vi.mocked(api.kubernetesDescribe).mockResolvedValue({ resource: { resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout" } });
		vi.mocked(api.kubernetesWorkload).mockResolvedValue({ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout", containers: [{ name: "app", limits: { cpu: "1" } }, { name: "sidecar" }], usage: [{ kind: "Pod", namespace: "default", name: "checkout-abc", cpu: "250m", memory: "256Mi" }], truncated: false });
		renderPage();
		await screen.findByText("checkout");
		fireEvent.click(screen.getByRole("button", { name: "Select Deployment default/checkout" }));
		const metrics = await screen.findByRole("region", { name: /Current workload metrics snapshot/ });
		expect(metrics.getAttribute("aria-label")).toMatch(/CPU normalized within this workload; memory normalized within this workload/i);
		expect(within(metrics).queryByText(/CPU normalized/i)).toBeNull();
	});

	it("shows an explicit metrics unavailable state for a selected workload without samples", async () => {
		vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: [{ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout" }], truncated: false });
		vi.mocked(api.kubernetesDescribe).mockResolvedValue({ resource: { resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout" } });
		vi.mocked(api.kubernetesWorkload).mockResolvedValue({ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout", truncated: false });
		renderPage();
		await screen.findByText("checkout");
		fireEvent.click(screen.getByRole("button", { name: "Select Deployment default/checkout" }));
		expect(await screen.findByText("Metrics API unavailable.")).toBeTruthy();
	});

	it("uses receive time for an actual-span chart, breaks paths across polling gaps, and retains history", async () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-08-30T12:00:00Z");
		vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: [{ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout" }], truncated: false });
		vi.mocked(api.kubernetesDescribe).mockResolvedValue({ resource: { resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout" } });
		vi.mocked(api.kubernetesWorkload).mockResolvedValue({ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout", pods: [{ name: "checkout-abc", restart_count: 0 }], truncated: false });
		vi.mocked(api.kubernetesUsage)
			.mockResolvedValueOnce({ observed_at: "2026-08-30T09:00:00Z", availability: "available", fresh: true, pods: [{ kind: "Pod", namespace: "default", name: "checkout-abc", cpu: "100m", memory: "128Mi" }], truncated: false })
			.mockResolvedValueOnce({ observed_at: "2026-08-30T14:00:00Z", availability: "available", fresh: true, pods: [{ kind: "Pod", namespace: "default", name: "checkout-abc", cpu: "250m", memory: "256Mi" }], truncated: false })
			.mockResolvedValueOnce({ observed_at: "2026-08-30T12:00:05Z", availability: "available", fresh: true, pods: [{ kind: "Pod", namespace: "default", name: "checkout-abc", cpu: "500m", memory: "512Mi" }], truncated: false })
			.mockRejectedValueOnce(new Error("temporary metrics failure"))
			.mockRejectedValueOnce(new Error("temporary metrics failure"))
			.mockResolvedValue({ observed_at: "2026-08-30T12:01:15Z", availability: "available", fresh: true, pods: [{ kind: "Pod", namespace: "default", name: "checkout-abc", cpu: "750m", memory: "768Mi" }], truncated: false });
		renderPage();
		await vi.waitFor(() => expect(screen.getByText("checkout")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Select Deployment default/checkout" }));
		await vi.waitFor(() => expect(api.kubernetesWorkload).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(screen.getAllByText("Collecting 15-minute history.")).toHaveLength(2));
		expect(screen.queryByText(/polling every 15 seconds/)).toBeNull();
		await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
		await vi.waitFor(() => expect(api.kubernetesUsage).toHaveBeenCalledTimes(2));
		await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
		await vi.waitFor(() => expect(api.kubernetesUsage).toHaveBeenCalledTimes(3));
		expect(api.kubernetesWorkload).toHaveBeenCalledTimes(1);
		const cpuChart = screen.getByRole("img", { name: /Workload CPU collected since/ });
		const memoryChart = screen.getByRole("img", { name: /Workload Memory collected since/ });
		expect(cpuChart.querySelector('[data-series="cpu"]')?.getAttribute("d")).toContain("L");
		expect(memoryChart.querySelector('[data-series="memory"]')?.getAttribute("d")).toContain("L");
		expect(cpuChart.parentElement?.getAttribute("tabindex")).toBe("0");
		expect(memoryChart.parentElement?.getAttribute("tabindex")).toBe("0");
		fireEvent.pointerMove(cpuChart, { clientX: 0 });
		expect(within(cpuChart).getByTestId("cpu-tooltip").textContent).toContain("100 mCPU");
		fireEvent.pointerLeave(cpuChart);
		expect(within(cpuChart).queryByTestId("cpu-tooltip")).toBeNull();
		fireEvent.focus(cpuChart.parentElement!);
		fireEvent.keyDown(cpuChart.parentElement!, { key: "End" });
		expect(cpuChart.parentElement?.querySelector("#live-cpu-metric-value")?.textContent).toContain("500 mCPU");
		expect(screen.queryByText(/15m ago/)).toBeNull();
		expect(screen.queryByText("CPU, separate scale")).toBeNull();
		expect(screen.queryByText("Memory, separate scale")).toBeNull();
		expect(screen.queryByText("15-minute range")).toBeNull();
		await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
		await vi.waitFor(() => expect(api.kubernetesUsage).toHaveBeenCalledTimes(6));
		const gappedPath = cpuChart.querySelector('[data-series="cpu"]')?.getAttribute("d") ?? "";
		expect(gappedPath).toMatch(/L .*M /);
		fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
		fireEvent.click(screen.getByRole("button", { name: "Select Deployment default/checkout" }));
		expect(screen.getByRole("img", { name: /Workload CPU collected since/ })).toBeTruthy();
		expect(screen.getByRole("img", { name: /Workload Memory collected since/ })).toBeTruthy();
	});

	it("omits historical snapshots missing a current workload pod", async () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-08-30T12:00:00Z");
		vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: [{ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout" }], truncated: false });
		vi.mocked(api.kubernetesDescribe).mockResolvedValue({ resource: { resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout" } });
		vi.mocked(api.kubernetesWorkload).mockResolvedValue({ resource_id: "apps~v1~deployments", kind: "Deployment", namespace: "default", name: "checkout", pods: [{ name: "checkout-a", restart_count: 0 }, { name: "checkout-b", restart_count: 0 }], truncated: false });
		vi.mocked(api.kubernetesUsage)
			.mockResolvedValueOnce({ observed_at: "2026-08-30T12:00:00Z", availability: "available", fresh: true, pods: [{ kind: "Pod", namespace: "default", name: "checkout-a", cpu: "100m", memory: "128Mi" }], nodes: [{ kind: "Node", name: "node-a", cpu: "8", memory: "64Gi", extra: "not retained" } as never], truncated: false })
			.mockResolvedValue({ observed_at: "2026-08-30T12:00:15Z", availability: "available", fresh: true, pods: [{ kind: "Pod", namespace: "default", name: "checkout-a", cpu: "200m", memory: "256Mi" }, { kind: "Pod", namespace: "default", name: "checkout-b", cpu: "300m", memory: "384Mi" }], truncated: false });
		renderPage();
		await vi.waitFor(() => expect(screen.getByText("checkout")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Select Deployment default/checkout" }));
		await vi.waitFor(() => expect(screen.getAllByText("Collecting 15-minute history.")).toHaveLength(2));
		await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
		await vi.waitFor(() => expect(api.kubernetesUsage).toHaveBeenCalledTimes(2));
		expect(screen.queryByRole("img", { name: /Workload (CPU|Memory) collected/ })).toBeNull();
		expect(screen.getAllByText("Collecting 15-minute history.")).toHaveLength(2);
	});

	it("renders finite metric paths for samples received in the same millisecond", async () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-08-30T12:00:00Z");
		vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: [{ resource_id: "core~v1~pods", kind: "Pod", namespace: "default", name: "api" }], truncated: false });
		vi.mocked(api.kubernetesUsage)
			.mockResolvedValueOnce({ observed_at: "2026-08-30T12:00:00Z", availability: "available", fresh: true, pods: [{ kind: "Pod", namespace: "default", name: "api", cpu: "100m", memory: "128Mi" }], truncated: false })
			.mockResolvedValue({ observed_at: "2026-08-30T12:00:01Z", availability: "available", fresh: true, pods: [{ kind: "Pod", namespace: "default", name: "api", cpu: "200m", memory: "256Mi" }], truncated: false });
		renderPage();
		await vi.waitFor(() => expect(screen.getByText("api")).toBeTruthy());
		fireEvent.click(screen.getByRole("button", { name: "Select Pod default/api" }));
		await vi.waitFor(() => expect(screen.getAllByText("Collecting 15-minute history.")).toHaveLength(2));
		await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
		await vi.waitFor(() => expect(screen.getByRole("img", { name: /Workload CPU collected since/ })).toBeTruthy());
		const chart = screen.getByRole("img", { name: /Workload CPU collected since/ });
		const path = chart.querySelector('[data-series="cpu"]')?.getAttribute("d") ?? "";
		expect(path).toContain("L");
		expect(path).not.toMatch(/NaN|Infinity/);
	});

	it("renders raw limited-RBAC nullable responses without crashing", async () => {
		vi.mocked(api.kubernetesOverview).mockResolvedValue({ connector: "kubernetes", cluster_id: "limited", observed_at: "2026-08-30T12:00:00Z", nodes: 1, ready_nodes: 1, pods: 1, running_pods: 1, namespaces: 0, active_namespaces: 0, workloads: 1, warnings: 0, usage_source: null, metrics_status: null, metrics_fresh: false, truncated: true, omitted_categories: null, partial_failures: [{ resource_id: "core~v1~events", class: "forbidden" }] });
		vi.mocked(api.kubernetesUsage).mockResolvedValue({ observed_at: "2026-08-30T12:00:00Z", availability: "unavailable", fresh: false, pod_metrics: null as never, node_metrics: null as never, pods: null, nodes: null, truncated: true, omitted_categories: null, partial_failures: [{ class: "forbidden" }] });
		vi.mocked(api.kubernetesWorkloads).mockResolvedValue({ items: null, truncated: true, omitted_categories: null, partial_failures: [{ class: "forbidden" }] });
		vi.mocked(api.kubernetesNodes).mockResolvedValue({ items: null, truncated: true, omitted_categories: ["core~v1~nodes"], partial_failures: [{ class: "forbidden" }] });
		vi.mocked(api.kubernetesEvents).mockResolvedValue({ items: null, truncated: true, partial_failures: [{ class: "forbidden" }] });
		renderPage();
		expect(await screen.findByRole("button", { name: "2 Kubernetes overview warnings" })).toBeTruthy();
		expect(screen.getByText("No workloads in this scope.")).toBeTruthy();
		expect(screen.getByText("No recent warning events.")).toBeTruthy();
		expect(screen.getByText("No nodes in this cluster.")).toBeTruthy();
		expect(screen.getAllByRole("status").some((status) => status.textContent?.includes("forbidden"))).toBe(true);
		expect(screen.queryByText("Couldn't render this page")).toBeNull();
	});

	it("shows actionable connector diagnostics", async () => {
		vi.mocked(api.kubernetesOverview).mockRejectedValue(new ApiError(502, "Kubernetes credentials are unavailable.", {
			error: "Kubernetes credentials are unavailable.",
			code: "credential_unavailable",
			action: "Configure a credential source for tools.kubernetes.auth.mode and restart Versus.",
			retryable: false,
		}));
		renderPage();
		expect(await screen.findByText("Kubernetes credentials are unavailable.")).toBeTruthy();
		expect(screen.getByText("Configure a credential source for tools.kubernetes.auth.mode and restart Versus.")).toBeTruthy();
	});
});