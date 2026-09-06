import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Cpu,
  Database,
  Network,
  RefreshCw,
  Search,
  Server,
  ShipWheel,
} from "lucide-react";
import { api, type KubernetesResource } from "@/lib/api";
import { Pagination } from "@/components/Pagination";
import { PeekPanel, PeekField } from "@/components/PeekPanel";
import { RetryableError } from "@/components/RetryableError";
import { SkCard } from "@/components/Skeleton";
import { TopBar } from "@/components/TopBar";
import { usePagination } from "@/lib/pagination";

const stats = [
  ["Nodes", "nodes", Server],
  ["Pods", "pods", Boxes],
  ["Workloads", "workloads", ShipWheel],
  ["Namespaces", "namespaces", Network],
  ["Warnings", "warnings", AlertTriangle],
] as const;

const statResourceIDs = {
  nodes: ["core~v1~nodes"],
  pods: ["core~v1~pods"],
  workloads: [
    "apps~v1~deployments",
    "apps~v1~statefulsets",
    "apps~v1~daemonsets",
    "batch~v1~jobs",
    "batch~v1~cronjobs",
  ],
  namespaces: ["core~v1~namespaces"],
  warnings: ["core~v1~events"],
} satisfies Record<(typeof stats)[number][1], readonly string[]>;

const workloadKinds = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
  "Pod",
]);
const kubernetesPageSize = 20;
const usageWindowMilliseconds = 15 * 60 * 1000;
const usagePollingMilliseconds = 15_000;
const usageGapMilliseconds = usagePollingMilliseconds * 2.5;
const usageSnapshotLimit = 61;
const usagePodSampleLimit = 500;

const quantityUnits: Record<string, number> = {
  "": 1,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function readable(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function parseQuantity(value: string | undefined): number | null {
  const input = value?.trim();
  if (!input) return null;

  const rational = input.match(/^([+-]?\d+)\/([+-]?\d+)$/);
  if (rational) {
    const denominator = Number(rational[2]);
    const result = Number(rational[1]) / denominator;
    return denominator !== 0 && Number.isFinite(result) ? result : null;
  }

  const quantity = input.match(
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(n|u|µ|m|k|K|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/,
  );
  if (!quantity) return null;
  const result = Number(quantity[1]) * quantityUnits[quantity[2] ?? ""];
  return Number.isFinite(result) ? result : null;
}

function formatAmount(value: number, maximumFractionDigits = 2): string {
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

function formatCPU(value: string | undefined): string {
  const cores = parseQuantity(value);
  if (cores === null) return "Unavailable";
  if (Math.abs(cores) < 1) return `${formatAmount(cores * 1000, 3)} mCPU`;
  const formatted = formatAmount(cores, 3);
  return `${formatted} ${formatted === "1" || formatted === "-1" ? "core" : "cores"}`;
}

function formatMemory(value: string | undefined): string {
  const bytes = parseQuantity(value);
  if (bytes === null) return "Unavailable";
  const units = [
    ["TiB", 2 ** 40],
    ["GiB", 2 ** 30],
    ["MiB", 2 ** 20],
    ["KiB", 2 ** 10],
    ["B", 1],
  ] as const;
  const unit =
    units.find(([, divisor]) => Math.abs(bytes) >= divisor) ??
    units[units.length - 1];
  return `${formatAmount(bytes / unit[1], 2)} ${unit[0]}`;
}

export function KubernetesPage() {
  const [name, setName] = useState("");
  const [workloadNamespace, setWorkloadNamespace] = useState("All");
  const [selected, setSelected] = useState<KubernetesResource | null>(null);
  const [selectedNode, setSelectedNode] = useState<KubernetesResource | null>(
    null,
  );
  const [workloadKind, setWorkloadKind] = useState("All");
  const [expandedWarnings, setExpandedWarnings] = useState<Set<string>>(
    () => new Set(),
  );
  const [usageHistory, setUsageHistory] = useState<{
    namespace: string;
    snapshots: UsageSnapshot[];
  }>({ namespace: "", snapshots: [] });
  const overview = useQuery({
    queryKey: ["kubernetes-overview"],
    queryFn: api.kubernetesOverview,
    retry: false,
  });

  const usage = useQuery({
    queryKey: ["kubernetes-usage"],
    queryFn: () => api.kubernetesUsage(),
    retry: false,
    refetchInterval: usagePollingMilliseconds,
    refetchIntervalInBackground: false,
  });
  const workloads = useQuery({
    queryKey: ["kubernetes-workloads"],
    queryFn: () => api.kubernetesWorkloads(),
    retry: false,
  });
  const nodes = useQuery({
    queryKey: ["kubernetes-nodes"],
    queryFn: api.kubernetesNodes,
    retry: false,
  });
  const nodePods = useQuery({
    queryKey: ["kubernetes-node-pods", selectedNode?.name],
    queryFn: () => api.kubernetesNodePods(selectedNode!.name),
    enabled: selectedNode !== null,
    retry: false,
  });
  const warnings = useQuery({
    queryKey: ["kubernetes-warnings"],
    queryFn: () => api.kubernetesEvents(),
    retry: false,
  });
  const detail = useQuery({
    queryKey: [
      "kubernetes-detail",
      selected?.resource_id,
      selected?.namespace,
      selected?.name,
    ],
    queryFn: () =>
      api.kubernetesDescribe(
        selected!.resource_id,
        selected?.namespace ?? "",
        selected!.name,
      ),
    enabled: selected !== null,
    retry: false,
  });
  const workloadDetailEnabled =
    selected !== null && workloadKinds.has(selected.kind);
  const workloadDetail = useQuery({
    queryKey: [
      "kubernetes-workload",
      selected?.kind,
      selected?.namespace,
      selected?.name,
    ],
    queryFn: () =>
      api.kubernetesWorkload(
        selected!.kind,
        selected?.namespace ?? "",
        selected!.name,
      ),
    enabled: workloadDetailEnabled,
    retry: false,
  });
  const visibleResources = asArray(workloads.data?.items);
  const workloadNamespaces = [
    ...new Set(
      visibleResources.map((resource) => resource.namespace || "Cluster scope"),
    ),
  ].sort();
  const workloadKindOptions = [
    ...new Set(visibleResources.map((resource) => resource.kind)),
  ].sort();
  const workloadQuery = name.trim().toLocaleLowerCase();
  const filteredResources = visibleResources.filter((resource) => {
    const resourceNamespace = resource.namespace || "Cluster scope";
    if (workloadNamespace !== "All" && resourceNamespace !== workloadNamespace)
      return false;
    if (workloadKind !== "All" && resource.kind !== workloadKind) return false;
    if (!workloadQuery) return true;
    return [resource.name, resourceNamespace, resource.kind, workloadStatus(resource)]
      .some((value) => value.toLocaleLowerCase().includes(workloadQuery));
  });
  const warningEvents = asArray(warnings.data?.items);
  const nodeItems = asArray(nodes.data?.items);
  const selectedNodePods = asArray(nodePods.data?.items);
  const workloadPagination = usePagination(filteredResources, {
    pageSize: kubernetesPageSize,
    resetKey: `${workloadNamespace}:${workloadQuery}:${workloadKind}`,
  });
  const warningPagination = usePagination(warningEvents, {
    pageSize: kubernetesPageSize,
    resetKey: "warnings",
  });
  const nodePagination = usePagination(nodeItems, {
    pageSize: kubernetesPageSize,
    resetKey: "nodes",
  });
  const nodePodPagination = usePagination(selectedNodePods, {
    pageSize: kubernetesPageSize,
    resetKey: selectedNode?.name ?? "",
  });

  useEffect(() => {
    if (workloadKind !== "All" && !workloadKindOptions.includes(workloadKind))
      setWorkloadKind("All");
  }, [workloadKind, workloadKindOptions]);

  useEffect(() => {
    if (
      workloadNamespace !== "All" &&
      !workloadNamespaces.includes(workloadNamespace)
    )
      setWorkloadNamespace("All");
  }, [workloadNamespace, workloadNamespaces]);

  useEffect(() => {
    if (!usage.data) return;
    const parsedObservedAt = Date.parse(usage.data.observed_at);
    const snapshot: UsageSnapshot = {
      key: Number.isFinite(parsedObservedAt)
        ? usage.data.observed_at
        : String(usage.dataUpdatedAt),
      observedAt: usage.dataUpdatedAt,
      pods: asArray(usage.data.pods)
        .slice(0, usagePodSampleLimit)
        .map((pod) => ({
          namespace: pod.namespace,
          name: pod.name,
          cpu: pod.cpu,
          memory: pod.memory,
        })),
    };
    setUsageHistory((current) => {
      const snapshots = current.namespace === "" ? current.snapshots : [];
      const cutoff = usage.dataUpdatedAt - usageWindowMilliseconds;
      const retained = snapshots.filter(
        (item) => item.observedAt >= cutoff && item.key !== snapshot.key,
      );
      const next =
        snapshot.observedAt >= cutoff ? [...retained, snapshot] : retained;
      return {
        namespace: "",
        snapshots: next
          .sort((left, right) => left.observedAt - right.observedAt)
          .slice(-usageSnapshotLimit),
      };
    });
  }, [usage.data, usage.dataUpdatedAt]);

  const historyNow = usage.dataUpdatedAt || Date.now();
  const liveMetrics = useMemo(
    () =>
      workloadDetail.data
        ? workloadMetricSamples(
            usageHistory.namespace === "" ? usageHistory.snapshots : [],
            workloadDetail.data,
            selected,
            historyNow,
          )
        : [],
    [
      historyNow,
      selected,
      usageHistory,
      workloadDetail.data,
    ],
  );
  const refreshAll = () => {
    overview.refetch();
    usage.refetch();
    workloads.refetch();
    nodes.refetch();
    if (selectedNode) nodePods.refetch();
    warnings.refetch();
  };
  const podsUnavailable = overview.data
    ? categoryUnavailable(overview.data, statResourceIDs.pods)
    : false;
  const nodesUnavailable = overview.data
    ? categoryUnavailable(overview.data, statResourceIDs.nodes)
    : false;
  const overviewWarningMessages = overview.data
    ? [
        ...(overview.data.partial_failures?.length
          ? [
              `Partial cluster visibility: ${[
                ...new Set(
                  overview.data.partial_failures.map((failure) => failure.class),
                ),
              ].join(", ")}`,
            ]
          : []),
        ...(overview.data.truncated
          ? ["Overview reached its collection bound. Some categories are omitted."]
          : []),
      ]
    : [];

  return (
    <main className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      <TopBar
        title="Kubernetes"
        actions={
          <div className="flex items-center gap-1">
            {overviewWarningMessages.length > 0 && (
              <OverviewWarningIndicator messages={overviewWarningMessages} />
            )}
            <button
              type="button"
              onClick={refreshAll}
              disabled={overview.isRefetching}
              aria-label="Refresh Kubernetes data"
              title="Refresh Kubernetes data"
              className="inline-flex size-9 items-center justify-center rounded-control text-ink-300 hover:bg-ink-700 hover:text-ink-100 disabled:opacity-50"
            >
              <RefreshCw
                size={15}
                className={overview.isRefetching ? "animate-spin" : undefined}
              />
            </button>
          </div>
        }
      />
      <div className="mx-auto min-w-0 max-w-7xl space-y-5 overflow-x-hidden p-4 sm:p-6">
        {overview.isPending && (
          <div aria-label="Loading Kubernetes overview">
            <SkCard lines={4} />
          </div>
        )}
        {overview.isError && (
          <RetryableError
            error={overview.error}
            onRetry={() => overview.refetch()}
            retrying={overview.isRefetching}
            context="Couldn't load Kubernetes overview"
          />
        )}

        {overview.data && (
          <>
            <section
              aria-label="Cluster health"
              className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
            >
              {stats.map(([label, key, Icon]) => {
                const unavailable = categoryUnavailable(
                  overview.data,
                  statResourceIDs[key],
                );
                const warning =
                  !unavailable &&
                  key === "warnings" &&
                  overview.data[key] > 0;
                return (
                  <article className="card min-h-28 p-4" key={key}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-ink-300">
                        {label}
                      </span>
                      <Icon
                        size={16}
                        className={
                          warning ? "text-sev-warning" : "text-accent-300"
                        }
                        aria-hidden="true"
                      />
                    </div>
                    <div
                      className={`${unavailable ? "text-lg" : "text-2xl"} mt-3 font-semibold text-ink-50`}
                    >
                      {unavailable ? "Unavailable" : overview.data[key]}
                    </div>
                    <p className="mt-1 text-2xs text-ink-400">
                      {unavailable
                        ? `${label} count unavailable`
                        : key === "nodes"
                          ? `Nodes ready ${overview.data.ready_nodes}/${overview.data.nodes}`
                          : key === "pods"
                            ? `Pods running ${overview.data.running_pods}/${overview.data.pods}`
                            : key === "namespaces"
                              ? `Namespaces active ${overview.data.active_namespaces}/${overview.data.namespaces}`
                              : key === "workloads"
                                ? "discovered resources"
                                : warning
                                  ? "needs attention"
                                  : "no active warnings"}
                    </p>
                  </article>
                );
              })}
            </section>

            <div className="grid gap-3 lg:grid-cols-2">
              <CapacityPanel
                icon={Cpu}
                title="CPU capacity"
                formatter={formatCPU}
                values={[
                  [
                    "Requested",
                    podsUnavailable ? undefined : overview.data.requested_cpu,
                  ],
                  [
                    "Limited",
                    podsUnavailable ? undefined : overview.data.limited_cpu,
                  ],
                  [
                    "Allocatable",
                    nodesUnavailable ? undefined : overview.data.allocatable_cpu,
                  ],
                  ["Usage", overview.data.usage_cpu],
                ]}
              />
              <CapacityPanel
                icon={Database}
                title="Memory capacity"
                formatter={formatMemory}
                values={[
                  [
                    "Requested",
                    podsUnavailable
                      ? undefined
                      : overview.data.requested_memory,
                  ],
                  [
                    "Limited",
                    podsUnavailable ? undefined : overview.data.limited_memory,
                  ],
                  [
                    "Allocatable",
                    nodesUnavailable
                      ? undefined
                      : overview.data.allocatable_memory,
                  ],
                  ["Usage", overview.data.usage_memory],
                ]}
              />
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-ink-700 py-3 text-xs text-ink-300">
              <span className="inline-flex items-center gap-1.5">
                <Activity size={13} className="text-accent-300" />
                Metrics {overview.data.metrics_status ?? "unavailable"}
              </span>
              <span>
                source{" "}
                {(overview.data.usage_source ?? "unavailable").replace(
                  "_",
                  " ",
                )}
              </span>
              <span role="status">
                {usage.isPending
                  ? "Loading usage samples"
                  : usage.isError
                    ? "Usage samples unavailable"
                    : (usage.data?.availability ?? "unavailable") ===
                        "unavailable"
                      ? "Usage unavailable"
                      : `Usage ${usage.data?.fresh ? "fresh" : "stale"} · ${asArray(usage.data?.pods).length} pod samples · ${asArray(usage.data?.nodes).length} node samples${usage.data?.truncated ? " · partial" : ""}`}
              </span>
              {overview.data.metrics_observed_at && (
                <span className="ml-auto">
                  Sampled{" "}
                  {new Date(overview.data.metrics_observed_at).toLocaleString()}
                </span>
              )}
            </div>

          </>
        )}

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(18rem,0.85fr)]">
          <SectionFrame
            title="Workloads"
            icon={<Boxes size={16} />}
            trailing={
              <span className="text-xs text-ink-400">
                {visibleResources.length} visible
              </span>
            }
          >
            <div className="grid gap-2 border-b border-ink-700 p-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
              <div className="relative min-w-0 flex-1">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-3 top-2.5 text-ink-400"
                  aria-hidden="true"
                />
                <input
                  aria-label="Resource name"
                  className="w-full rounded-control border border-ink-600 bg-ink-900 py-2 pl-9 pr-3 text-sm text-ink-50"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Search resource names"
                />
              </div>
              <label className="text-2xs text-ink-400">
                <span className="sr-only">Workload namespace</span>
                <select
                  aria-label="Workload namespace"
                  className="input h-full w-full"
                  value={workloadNamespace}
                  onChange={(event) => setWorkloadNamespace(event.target.value)}
                >
                  <option value="All">All namespaces</option>
                  {workloadNamespaces.map((value) => (
                    <option value={value} key={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {workloadKindOptions.length > 0 && (
              <KindTabs
                label="Workload kind"
                kinds={workloadKindOptions}
                selected={workloadKind}
                onSelect={setWorkloadKind}
              />
            )}
            {workloads.isPending && (
              <div className="p-4">
                <SkCard lines={4} />
              </div>
            )}
            {workloads.isError && (
              <p role="status" className="p-4 text-sm text-sev-warning">
                Resource inventory is unavailable.
              </p>
            )}
            {!workloads.isPending && !workloads.isError && (
                <div className="overflow-hidden">
                  {visibleResources.length > 0 && (
                    <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7rem_minmax(7rem,1fr)_1.5rem] gap-3 border-b border-ink-700 bg-ink-900/40 px-4 py-2 text-2xs font-medium uppercase text-ink-400 sm:grid">
                      <span>Name</span>
                      <span>Namespace</span>
                      <span>Kind</span>
                      <span>Readiness / status</span>
                      <span className="sr-only">Select</span>
                    </div>
                  )}
                  <div
                    role="list"
                    className="max-h-[32rem] divide-y divide-ink-700 overflow-y-auto"
                  >
                    {workloadPagination.pageItems.map((item) => (
                      <ResourceRow
                        key={`${item.resource_id}:${item.namespace}:${item.name}`}
                        item={item}
                        selected={
                          selected?.resource_id === item.resource_id &&
                          selected?.namespace === item.namespace &&
                          selected?.name === item.name
                        }
                        onSelect={() => setSelected(item)}
                      />
                    ))}
                  </div>
                  {filteredResources.length === 0 && (
                    <EmptyState>
                      {visibleResources.length === 0
                        ? "No workloads in this scope."
                        : workloadQuery
                          ? "No matching workloads."
                          : workloadNamespace !== "All"
                            ? "No workloads in this namespace."
                            : `No ${workloadKind} resources in this scope.`}
                    </EmptyState>
                  )}
                  <Pagination state={workloadPagination} />
                </div>
              )}
            {workloads.data?.truncated ||
            workloads.data?.partial_failures?.length ? (
              <p
                role="status"
                className="min-w-0 break-words border-t border-ink-700 px-4 py-2 text-xs text-sev-warning"
              >
                Inventory is partial
                {workloads.data?.partial_failures?.some(
                  (failure) => failure.class === "forbidden",
                )
                  ? " because some resource kinds are forbidden"
                  : ""}
                .
              </p>
            ) : null}
          </SectionFrame>

          <SectionFrame
            title="Recent warnings"
            icon={<AlertTriangle size={16} />}
            trailing={
              warnings.data ? (
                <span className="text-xs text-ink-400">
                  {asArray(warnings.data.items).length} events
                </span>
              ) : undefined
            }
          >
            {warnings.isPending && (
              <div className="p-4">
                <SkCard lines={4} />
              </div>
            )}
            {warnings.isError && (
              <p role="status" className="p-4 text-sm text-sev-warning">
                Warning events are unavailable.
              </p>
            )}
            {warnings.data && (
              <div className="overflow-hidden">
                <div className="max-h-[32rem] divide-y divide-ink-700 overflow-y-auto">
                  {warningPagination.pageItems.map((event) => {
                    const key = warningKey(event);
                    return (
                      <WarningRow
                        event={event}
                        expanded={expandedWarnings.has(key)}
                        onToggle={() =>
                          setExpandedWarnings((current) => {
                            const next = new Set(current);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                        key={key}
                      />
                    );
                  })}
                  {warningEvents.length === 0 && (
                    <EmptyState
                      icon={<CircleCheck size={20} className="text-sev-ok" />}
                    >
                      No recent warning events.
                    </EmptyState>
                  )}
                </div>
                <Pagination state={warningPagination} />
              </div>
            )}
            {warnings.data?.truncated ||
            warnings.data?.partial_failures?.length ? (
              <p
                role="status"
                className="min-w-0 break-words border-t border-ink-700 px-4 py-2 text-xs text-sev-warning"
              >
                Warning evidence is partial.
              </p>
            ) : null}
          </SectionFrame>
        </div>

        <SectionFrame
          title="Nodes"
          icon={<Server size={16} />}
          trailing={
            nodes.data ? (
              <span className="text-xs text-ink-400">
                {nodeItems.length} nodes
              </span>
            ) : undefined
          }
        >
          {selectedNode ? (
            <NodePods
              node={selectedNode}
              isPending={nodePods.isPending}
              isError={nodePods.isError}
              truncated={Boolean(nodePods.data?.truncated)}
              partialFailures={nodePods.data?.partial_failures}
              items={selectedNodePods}
              pagination={nodePodPagination}
              onClose={() => setSelectedNode(null)}
            />
          ) : (
            <>
              {nodes.isPending && (
                <div className="p-4">
                  <SkCard lines={3} />
                </div>
              )}
              {nodes.isError && (
                <p role="status" className="p-4 text-sm text-sev-warning">
                  Nodes are unavailable.
                </p>
              )}
              {nodes.data && (
                <div className="min-w-0 overflow-hidden">
                  <div role="list" className="divide-y divide-ink-700">
                    {nodePagination.pageItems.map((node) => (
                      <NodeRow
                        node={node}
                        onSelect={() => setSelectedNode(node)}
                        key={node.name}
                      />
                    ))}
                  </div>
                  {nodeItems.length === 0 && (
                    <EmptyState>No nodes in this cluster.</EmptyState>
                  )}
                  <Pagination state={nodePagination} />
                </div>
              )}
              {(nodes.data?.truncated ||
                nodes.data?.partial_failures?.length) && (
                <p
                  role="status"
                  className="min-w-0 break-words border-t border-ink-700 px-4 py-2 text-xs text-sev-warning"
                >
                  Node inventory is partial
                  {nodes.data.partial_failures?.some(
                    (failure) => failure.class === "forbidden",
                  )
                    ? " because nodes are forbidden"
                    : ""}
                  .
                </p>
              )}
            </>
          )}
        </SectionFrame>
      </div>

      <PeekPanel
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={
          selected
            ? `${selected.kind} · ${selected.namespace ? `${selected.namespace}/` : ""}${selected.name}`
            : "Resource detail"
        }
      >
        {detail.isPending && <SkCard lines={5} />}
        {detail.isError && (
          <RetryableError
            error={detail.error}
            onRetry={() => detail.refetch()}
            retrying={detail.isRefetching}
            context="Couldn't load resource detail"
          />
        )}
        {detail.data && (
          <>
            <ResourceDetail
              resource={detail.data.resource}
              related={detail.data.related_resources}
              eventCount={detail.data.events?.length ?? 0}
              workload={workloadDetail.data}
            />
            {workloadDetail.data && (
              <>
                <LiveMetricsSection samples={liveMetrics} />
                <WorkloadSnapshot
                  workload={workloadDetail.data}
                  metricsStatus={overview.data?.metrics_status}
                />
              </>
            )}
          </>
        )}
      </PeekPanel>
    </main>
  );
}

function SectionFrame({
  title,
  icon,
  trailing,
  children,
}: {
  title: string;
  icon: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card min-w-0 overflow-hidden" aria-label={title}>
      <header className="card-header min-w-0">
        <h2 className="card-title flex min-w-0 items-center gap-2">
          {icon}
          <span>{title}</span>
        </h2>
        {trailing}
      </header>
      {children}
    </section>
  );
}

function KindTabs({
  label,
  kinds,
  selected,
  onSelect,
}: {
  label: string;
  kinds: string[];
  selected: string;
  onSelect: (kind: string) => void;
}) {
  const options = ["All", ...kinds];
  return (
    <div className="border-b border-ink-700 px-3 py-2">
      <label className="block text-2xs text-ink-400 sm:hidden">
        {label}
        <select
          aria-label={label}
          className="input mt-1 w-full"
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
        >
          {options.map((kind) => (
            <option value={kind} key={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
      <div
        role="tablist"
        aria-label={label}
        className="hidden flex-wrap gap-1 sm:flex"
      >
        {options.map((kind) => {
          const active = selected === kind;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className={`rounded-control px-3 py-1.5 text-xs font-medium ${active ? "bg-accent-subtle text-ink-50" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"}`}
              onClick={() => onSelect(kind)}
              key={kind}
            >
              {kind}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function categoryUnavailable(
  overview: {
    omitted_categories?: string[] | null;
    partial_failures?: Array<{ resource_id?: string }> | null;
  },
  resourceIDs: readonly string[],
): boolean {
  return (
    resourceIDs.some((resourceID) =>
      asArray(overview.omitted_categories).includes(resourceID),
    ) ||
    asArray(overview.partial_failures).some(
      (failure) =>
        failure.resource_id !== undefined &&
        resourceIDs.includes(failure.resource_id),
    )
  );
}

function CapacityPanel({
  icon: Icon,
  title,
  values,
  formatter,
}: {
  icon: typeof Cpu;
  title: string;
  values: Array<[string, string | undefined]>;
  formatter: (value: string | undefined) => string;
}) {
  return (
    <section className="card overflow-hidden">
      <header className="card-header">
        <h2 className="card-title flex items-center gap-2">
          <Icon size={15} className="text-accent-300" />
          {title}
        </h2>
      </header>
      <dl className="grid grid-cols-2 divide-x divide-y divide-ink-700 sm:grid-cols-4 sm:divide-y-0">
        {values.map(([label, value]) => {
          const formatted = formatter(value);
          return (
            <div className="min-w-0 p-3" key={label}>
              <dt className="text-2xs text-ink-400">{label}</dt>
              <dd
                className="mt-1 truncate text-sm font-medium text-ink-100"
                title={formatted}
              >
                {formatted}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function ResourceRow({
  item,
  selected,
  onSelect,
}: {
  item: KubernetesResource;
  selected: boolean;
  onSelect: () => void;
}) {
  const condition = asArray(item.conditions).find(
    (entry) => entry.type === "Ready" || entry.status === "False",
  );
  const unhealthy = condition?.status === "False";
  const status = workloadStatus(item);
  return (
    <div role="listitem">
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Select ${item.kind} ${item.namespace ? `${item.namespace}/` : ""}${item.name}`}
        className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left hover:bg-ink-800/60 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7rem_minmax(7rem,1fr)_1.5rem] ${selected ? "bg-ink-800" : ""}`}
      >
        <div className="min-w-0">
          <span className="block truncate text-sm font-medium text-ink-50">
            {item.name}
          </span>
          <p className="mt-1 truncate text-2xs text-ink-400 sm:hidden">
            {item.namespace || "cluster scope"}
          </p>
        </div>
        <span className="hidden truncate text-xs text-ink-300 sm:block">
          {item.namespace || "cluster scope"}
        </span>
        <span className="pill w-fit">{item.kind}</span>
        <span
          className={`col-span-2 flex min-w-0 items-center gap-1.5 text-xs sm:col-span-1 ${unhealthy ? "text-sev-warning" : "text-ink-300"}`}
        >
          {unhealthy && (
            <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{status}</span>
        </span>
        <ChevronRight
          size={14}
          className="hidden text-ink-500 sm:block"
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

function OverviewWarningIndicator({ messages }: { messages: string[] }) {
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={`${messages.length} Kubernetes overview ${messages.length === 1 ? "warning" : "warnings"}`}
        aria-describedby="kubernetes-overview-warnings"
        className="inline-flex size-9 items-center justify-center rounded-control text-sev-warning hover:bg-sev-warning/10 focus-visible:bg-sev-warning/10"
      >
        <AlertTriangle size={16} />
      </button>
      <div
        id="kubernetes-overview-warnings"
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-tooltip mt-1 hidden w-72 max-w-[calc(100vw-1rem)] border border-ink-600 bg-ink-900 p-3 text-xs text-ink-100 shadow-xl group-hover:block group-focus-within:block"
      >
        <p className="font-semibold text-sev-warning">Cluster visibility warning</p>
        <ul className="mt-2 space-y-1.5">
          {messages.map((message) => (
            <li className="break-words" key={message}>
              {message}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function workloadStatus(item: KubernetesResource): string {
  const ready = asArray(item.conditions).find(
    (entry) => entry.type === "Ready",
  );
  if (ready)
    return ready.status === "True" ? "Ready" : ready.reason || "Not ready";
  const failed = asArray(item.conditions).find(
    (entry) => entry.status === "False",
  );
  if (failed) return failed.reason || `${failed.type} false`;
  const summary = item.summary ?? {};
  if (typeof summary.phase === "string" && summary.phase) return summary.phase;
  const readyCount = summary.readyReplicas ?? summary.numberReady;
  const desiredCount = summary.replicas ?? summary.desiredNumberScheduled;
  if (typeof readyCount === "number" && typeof desiredCount === "number")
    return `${readyCount}/${desiredCount} ready`;
  return "Unknown";
}

function warningKey(event: KubernetesResource): string {
  return `${event.uid ?? event.resource_id}:${event.namespace ?? ""}:${event.name}`;
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeValue(value: unknown, fallback = "Unavailable"): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : fallback;
}

function WarningRow({
  event,
  expanded,
  onToggle,
}: {
  event: KubernetesResource;
  expanded: boolean;
  onToggle: () => void;
}) {
  const summary = event.summary ?? {};
  const involved = safeRecord(summary.involved_object);
  const involvedKind = safeValue(
    involved?.kind,
    event.kind === "Event" ? "Resource" : event.kind,
  );
  const involvedNamespace = safeValue(
    involved?.namespace,
    event.namespace || "cluster scope",
  );
  const involvedName = safeValue(involved?.name, event.name);
  const reason = safeValue(summary.reason, event.name);
  return (
    <article>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-start gap-2 p-3 text-left hover:bg-ink-800/60"
      >
        <AlertTriangle
          size={14}
          className="mt-0.5 shrink-0 text-sev-warning"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-ink-100">
            {reason}
          </span>
          <span className="mt-1 block truncate text-2xs text-ink-400">
            {involvedKind} · {involvedNamespace}/{involvedName}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={`mt-0.5 shrink-0 text-ink-400 transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div className="space-y-3 border-t border-ink-700 bg-ink-900/30 px-4 py-3">
          <p className="break-words text-xs leading-5 text-ink-200">
            {safeValue(summary.message, "Warning event")}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <PeekField label="Involved kind">{involvedKind}</PeekField>
            <PeekField label="Namespace">{involvedNamespace}</PeekField>
            <PeekField label="Name">{involvedName}</PeekField>
            {summary.count !== undefined && (
              <PeekField label="Count">{safeValue(summary.count)}</PeekField>
            )}
            {summary.action !== undefined && (
              <PeekField label="Action">{safeValue(summary.action)}</PeekField>
            )}
            {summary.firstTimestamp !== undefined && (
              <PeekField label="First seen">
                {safeValue(summary.firstTimestamp)}
              </PeekField>
            )}
            {summary.lastTimestamp !== undefined && (
              <PeekField label="Last seen">
                {safeValue(summary.lastTimestamp)}
              </PeekField>
            )}
          </dl>
        </div>
      )}
    </article>
  );
}

function EmptyState({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-2 p-5 text-center text-sm text-ink-400">
      {icon}
      {children}
    </div>
  );
}

function NodeRow({
  node,
  onSelect,
}: {
  node: KubernetesResource;
  onSelect: () => void;
}) {
  const summary = node.summary ?? {};
  const ready = asArray(node.conditions).find(
    (condition) => condition.type === "Ready",
  );
  const status =
    ready?.status === "True" ? "Ready" : ready?.reason || "Not ready";
  return (
    <div role="listitem">
      <button
        type="button"
        aria-label={`View pods on ${node.name}`}
        onClick={onSelect}
        className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left hover:bg-ink-800/60 sm:grid-cols-[minmax(0,1.4fr)_minmax(7rem,0.7fr)_minmax(8rem,1fr)_minmax(8rem,1fr)_1rem]"
      >
        <span
          className="truncate text-sm font-medium text-ink-50"
          title={node.name}
        >
          {node.name}
        </span>
        <span
          className={
            ready?.status === "True"
              ? "text-xs text-sev-ok"
              : "text-xs text-sev-warning"
          }
        >
          {status}
        </span>
        <span className="hidden truncate text-xs text-ink-300 sm:block">
          {formatCPU(
            typeof summary.allocatable_cpu === "string"
              ? summary.allocatable_cpu
              : undefined,
          )}
        </span>
        <span className="hidden truncate text-xs text-ink-300 sm:block">
          {formatMemory(
            typeof summary.allocatable_memory === "string"
              ? summary.allocatable_memory
              : undefined,
          )}
        </span>
        <ChevronRight size={14} className="text-ink-500" aria-hidden="true" />
      </button>
    </div>
  );
}

type PaginationState<T> = ReturnType<typeof usePagination<T>>;

function NodePods({
  node,
  isPending,
  isError,
  truncated,
  partialFailures,
  items,
  pagination,
  onClose,
}: {
  node: KubernetesResource;
  isPending: boolean;
  isError: boolean;
  truncated: boolean;
  partialFailures?: Array<{ resource_id?: string; class: string }> | null;
  items: KubernetesResource[];
  pagination: PaginationState<KubernetesResource>;
  onClose: () => void;
}) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-ink-700 px-4 py-3">
        <div className="min-w-0">
          <p
            className="truncate text-sm font-medium text-ink-100"
            title={node.name}
          >
            {node.name}
          </p>
          <p className="text-2xs text-ink-400">
            Scheduled pods across all namespaces
          </p>
        </div>
        <button type="button" className="btn shrink-0" onClick={onClose}>
          All nodes
        </button>
      </div>
      {isPending && (
        <div className="p-4">
          <SkCard lines={3} />
        </div>
      )}
      {isError && (
        <p role="status" className="p-4 text-sm text-sev-warning">
          Scheduled pods are unavailable.
        </p>
      )}
      {!isPending && !isError && (
        <>
          <div
            role="list"
            aria-label={`Pods on ${node.name}`}
            className="divide-y divide-ink-700"
          >
            {pagination.pageItems.map((pod) => (
              <NodePodRow
                pod={pod}
                key={`${pod.namespace ?? ""}:${pod.name}`}
              />
            ))}
          </div>
          {items.length === 0 && (
            <EmptyState>No pods are scheduled to this node.</EmptyState>
          )}
          <Pagination state={pagination} />
        </>
      )}
      {truncated || partialFailures?.length ? (
        <p
          role="status"
          className="min-w-0 break-words border-t border-ink-700 px-4 py-2 text-xs text-sev-warning"
        >
          Scheduled pod inventory is partial
          {partialFailures?.some((failure) => failure.class === "forbidden")
            ? " because some pods are forbidden"
            : ""}
          .
        </p>
      ) : null}
    </div>
  );
}

function NodePodRow({ pod }: { pod: KubernetesResource }) {
  const summary = pod.summary ?? {};
  const phase =
    typeof summary.phase === "string" ? summary.phase : workloadStatus(pod);
  const restarts =
    typeof summary.restart_count === "number"
      ? summary.restart_count
      : "Unavailable";
  return (
    <div
      role="listitem"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_7rem_6rem]"
    >
      <span
        className="truncate text-ink-300"
        title={pod.namespace || "cluster scope"}
      >
        {pod.namespace || "cluster scope"}
      </span>
      <span className="truncate font-medium text-ink-100" title={pod.name}>
        {pod.name}
      </span>
      <span className="text-ink-300">{phase}</span>
      <span className="text-right tabular-nums text-ink-300">{restarts}</span>
    </div>
  );
}

type Workload = Awaited<ReturnType<typeof api.kubernetesWorkload>>;
type WorkloadUsage = NonNullable<Workload["usage"]>[number];
type LiveMetricSample = {
  observedAt: number;
  cpu: number | null;
  memory: number | null;
};
type UsagePodSample = {
  namespace?: string;
  name: string;
  cpu?: string;
  memory?: string;
};
type UsageSnapshot = {
  key: string;
  observedAt: number;
  pods: UsagePodSample[];
};

function workloadMetricSamples(
  snapshots: UsageSnapshot[],
  workload: Workload,
  selected: KubernetesResource | null,
  now: number,
): LiveMetricSample[] {
  const podNames = new Set(asArray(workload.pods).map((pod) => pod.name));
  if (selected?.kind === "Pod") podNames.add(selected.name);
  if (podNames.size === 0) return [];
  return snapshots
    .filter(
      (snapshot) =>
        snapshot.observedAt >= now - usageWindowMilliseconds &&
        snapshot.observedAt <= now,
    )
    .flatMap((snapshot) => {
      let cpu = 0;
      let memory = 0;
      let hasCPU = false;
      let hasMemory = false;
      const matchedPodNames = new Set<string>();
      for (const pod of snapshot.pods) {
        if (
          !podNames.has(pod.name) ||
          (workload.namespace ?? "") !== (pod.namespace ?? "")
        )
          continue;
        matchedPodNames.add(pod.name);
        const podCPU = parseQuantity(pod.cpu);
        const podMemory = parseQuantity(pod.memory);
        if (podCPU !== null) {
          cpu += podCPU;
          hasCPU = true;
        }
        if (podMemory !== null) {
          memory += podMemory;
          hasMemory = true;
        }
      }
      if (matchedPodNames.size !== podNames.size) return [];
      const sample = {
        observedAt: snapshot.observedAt,
        cpu: hasCPU ? cpu : null,
        memory: hasMemory ? memory : null,
      };
      return sample.cpu !== null || sample.memory !== null ? [sample] : [];
    });
}

function metricPath(
  samples: LiveMetricSample[],
  field: "cpu" | "memory",
  windowStart: number,
  now: number,
  maximum: number,
): string {
  const values = samples.map((sample) => sample[field]);
  let previousIndex: number | null = null;
  return values
    .map((value, index) => {
      if (value === null) {
        previousIndex = null;
        return "";
      }
      const x =
        40 +
        Math.max(
          0,
          Math.min(
            1,
            (samples[index].observedAt - windowStart) /
              Math.max(1, now - windowStart),
          ),
        ) *
          490;
      const y = 120 - (value / maximum) * 95;
      const contiguous =
        previousIndex !== null &&
        samples[index].observedAt - samples[previousIndex].observedAt <=
          usageGapMilliseconds;
      const command = contiguous ? "L" : "M";
      previousIndex = index;
      return `${command} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
}

function hasRenderableMetricPath(
  samples: LiveMetricSample[],
  field: "cpu" | "memory",
): boolean {
  return samples.some(
    (sample, index) =>
      index > 0 &&
      sample[field] !== null &&
      samples[index - 1][field] !== null &&
      sample.observedAt - samples[index - 1].observedAt <=
        usageGapMilliseconds,
  );
}

function LiveMetricsChart({
  samples,
  field,
}: {
  samples: LiveMetricSample[];
  field: "cpu" | "memory";
}) {
  const validSamples = samples.filter((sample) => sample[field] !== null);
  const [activeObservedAt, setActiveObservedAt] = useState<number | null>(null);
  const now = samples.at(-1)!.observedAt;
  const windowStart = Math.max(
    now - usageWindowMilliseconds,
    samples[0].observedAt,
  );
  const maximum = Math.max(...validSamples.map((sample) => sample[field] ?? 0));
  const scaleMaximum = Math.max(1, maximum);
  const first = new Date(windowStart).toLocaleTimeString();
  const last = new Date(now).toLocaleTimeString();
  const span = now - windowStart;
  const spanMinutes = Math.max(0, span / 60_000);
  const title = field === "cpu" ? "CPU" : "Memory";
  const formatter = field === "cpu" ? formatCPU : formatMemory;
  const label =
    span >= usageWindowMilliseconds
      ? `Workload ${title} collected over the rolling 15-minute window`
      : `Workload ${title} collected since ${first}`;
  const activeIndex =
    activeObservedAt === null
      ? -1
      : validSamples.findIndex(
          (sample) => sample.observedAt === activeObservedAt,
        );
  const active = activeIndex < 0 ? null : validSamples[activeIndex];
  const activeX =
    active === null ? 40 : 40 +
    Math.max(
      0,
      Math.min(
        1,
        (active.observedAt - windowStart) / Math.max(1, now - windowStart),
      ),
    ) *
      490;
  const activeValue = active?.[field] ?? null;
  const activeY = activeValue === null ? 120 : 120 - (activeValue / scaleMaximum) * 95;
  const setNearest = (clientX: number, currentTarget: SVGSVGElement) => {
    const bounds = currentTarget.getBoundingClientRect();
    const viewBoxX = (clientX - bounds.left) / Math.max(1, bounds.width) * 560;
    const ratio = Math.max(0, Math.min(1, (viewBoxX - 40) / 490));
    const targetTime = windowStart + ratio * (now - windowStart);
    let nearest = 0;
    for (let index = 1; index < validSamples.length; index++) {
      if (Math.abs(validSamples[index].observedAt - targetTime) < Math.abs(validSamples[nearest].observedAt - targetTime)) nearest = index;
    }
    setActiveObservedAt(validSamples[nearest].observedAt);
  };
  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (event.key === "Home") setActiveObservedAt(validSamples[0].observedAt);
    else if (event.key === "End")
      setActiveObservedAt(validSamples.at(-1)!.observedAt);
    else {
      const currentIndex = Math.max(0, activeIndex);
      const nextIndex = Math.max(
        0,
        Math.min(
          validSamples.length - 1,
          currentIndex + (event.key === "ArrowRight" ? 1 : -1),
        ),
      );
      setActiveObservedAt(validSamples[nextIndex].observedAt);
    }
  };
  const activeDescription = active && activeValue !== null
    ? `${new Date(active.observedAt).toLocaleTimeString()} · ${formatter(String(activeValue))}`
    : "Use arrow keys or hover over the chart to inspect samples.";
  return (
    <section className="min-w-0" aria-label={`${title} usage chart`}>
      <h4 className="text-2xs font-medium uppercase text-ink-400">{title}</h4>
      <div className="mt-2 min-w-0 overflow-x-auto" tabIndex={0} onFocus={() => setActiveObservedAt((current) => current ?? validSamples.at(-1)!.observedAt)} onBlur={() => setActiveObservedAt(null)} onKeyDown={moveSelection} aria-label={`${label}. ${validSamples.length} samples over ${formatAmount(spanMinutes, 1)} minutes.`} aria-describedby={`live-${field}-metric-value`}>
      <span id={`live-${field}-metric-value`} className="sr-only" aria-live="polite">{activeDescription}</span>
      <svg
        role="img"
        aria-label={label}
        viewBox="0 0 560 155"
        className="h-auto min-w-[28rem] text-ink-400"
        onPointerMove={(event: PointerEvent<SVGSVGElement>) => setNearest(event.clientX, event.currentTarget)}
        onPointerLeave={() => setActiveObservedAt(null)}
      >
        <title>{label}</title>
        <g stroke="currentColor" strokeOpacity="0.25">
          <line x1="40" y1="25" x2="530" y2="25" />
          <line x1="40" y1="72.5" x2="530" y2="72.5" />
          <line x1="40" y1="120" x2="530" y2="120" />
        </g>
        <g fill="currentColor" fontSize="10">
          <text x="40" y="145">
            {first}
          </text>
          <text x="530" y="145" textAnchor="end">
            Now · {last}
          </text>
          <text x="526" y="19" textAnchor="end">
            {formatter(String(maximum))}
          </text>
        </g>
        <path
          data-series={field}
          d={metricPath(samples, field, windowStart, now, scaleMaximum)}
          fill="none"
          stroke={field === "cpu" ? "rgb(56 189 248)" : "rgb(74 222 128)"}
          strokeWidth="2"
        />
        {validSamples.map((sample) => {
          const x =
            40 +
            Math.max(
              0,
              Math.min(
                1,
                (sample.observedAt - windowStart) /
                  Math.max(1, now - windowStart),
              ),
            ) *
              490;
          return (
            <g key={sample.observedAt}>
              <circle cx={x} cy={120 - (sample[field]! / scaleMaximum) * 95} r="2.5" fill={field === "cpu" ? "rgb(56 189 248)" : "rgb(74 222 128)"} />
            </g>
          );
        })}
        {active && activeValue !== null && <><line data-testid={`${field}-crosshair`} x1={activeX} y1="25" x2={activeX} y2="120" stroke="currentColor" strokeDasharray="3 3" />
        <circle data-testid={`${field}-active-point`} cx={activeX} cy={activeY} r="5" fill={field === "cpu" ? "rgb(56 189 248)" : "rgb(74 222 128)"} stroke="rgb(15 23 42)" strokeWidth="2" />
        <g data-testid={`${field}-tooltip`}>
          <rect x={Math.max(42, Math.min(390, activeX - 65))} y="2" width="138" height="20" rx="3" fill="rgb(15 23 42)" />
          <text x={Math.max(48, Math.min(396, activeX - 59))} y="16" fill="rgb(226 232 240)" fontSize="10">{activeDescription}</text>
        </g></>}
      </svg>
      </div>
    </section>
  );
}

function LiveMetricsSection({ samples }: { samples: LiveMetricSample[] }) {
  return (
    <section
      className="mt-5 border-t border-ink-700 pt-4"
      aria-label="Live workload metrics"
    >
      <h3 className="text-xs font-semibold text-ink-100">
        Live workload usage
      </h3>
      <div className="mt-3 grid min-w-0 gap-5">
        {(["cpu", "memory"] as const).map((field) => hasRenderableMetricPath(samples, field) ? <LiveMetricsChart samples={samples} field={field} key={field} /> : <section aria-label={`${field === "cpu" ? "CPU" : "Memory"} usage chart`} key={field}><h4 className="text-2xs font-medium uppercase text-ink-400">{field === "cpu" ? "CPU" : "Memory"}</h4><p role="status" className="mt-2 text-xs text-ink-400">Collecting 15-minute history.</p></section>)}
      </div>
    </section>
  );
}

function metricMaximum(rows: WorkloadUsage[], field: "cpu" | "memory"): number {
  return rows.reduce(
    (maximum, row) => Math.max(maximum, parseQuantity(row[field]) ?? 0),
    0,
  );
}

function configuredLimit(
  workload: Workload,
  field: "cpu" | "memory",
): number | null {
  const containers = asArray(workload.containers);
  if (containers.length === 0) return null;
  const limits = containers.map((container) =>
    parseQuantity(container.limits?.[field]),
  );
  if (limits.some((limit) => limit === null)) return null;
  const total = limits.reduce<number>((sum, limit) => sum + (limit ?? 0), 0);
  return total > 0 ? total : null;
}

function MetricBar({
  row,
  field,
  maximum,
}: {
  row: WorkloadUsage;
  field: "cpu" | "memory";
  maximum: number;
}) {
  const amount = parseQuantity(row[field]);
  const formatted =
    field === "cpu" ? formatCPU(row.cpu) : formatMemory(row.memory);
  const width =
    amount !== null && maximum > 0
      ? Math.max(0, Math.min(100, (amount / maximum) * 100))
      : 0;
  return (
    <div className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(6rem,1.5fr)_auto] items-center gap-2 py-1.5">
      <span className="truncate text-xs text-ink-200" title={row.name}>
        {row.name}
      </span>
      <div className="h-2 overflow-hidden rounded-control bg-ink-700">
        {amount !== null && (
          <div
            role="progressbar"
            aria-label={`${row.name} ${field} usage`}
            aria-valuemin={0}
            aria-valuemax={maximum}
            aria-valuenow={Math.max(0, Math.min(amount, maximum))}
            aria-valuetext={formatted}
            className="h-full rounded-control bg-accent"
            style={{ width: `${width}%` }}
          />
        )}
      </div>
      <span className="min-w-16 text-right text-2xs tabular-nums text-ink-300">
        {formatted}
      </span>
    </div>
  );
}

function WorkloadSnapshot({
  workload,
  metricsStatus,
}: {
  workload: Workload;
  metricsStatus?: "available" | "stale" | "unavailable" | null;
}) {
  const usage = asArray(workload.usage);
  const pods = asArray(workload.pods);
  const resetKey = `${workload.kind}:${workload.namespace ?? ""}:${workload.name}`;
  const usagePagination = usePagination(usage, {
    pageSize: kubernetesPageSize,
    resetKey,
  });
  const podPagination = usePagination(pods, {
    pageSize: kubernetesPageSize,
    resetKey,
  });
  const cpuLimit = configuredLimit(workload, "cpu");
  const memoryLimit = configuredLimit(workload, "memory");
  const cpuMaximum = cpuLimit ?? metricMaximum(usage, "cpu");
  const memoryMaximum = memoryLimit ?? metricMaximum(usage, "memory");
  const normalization = `CPU normalized ${cpuLimit === null ? "within this workload" : "against configured per-pod limits"}; memory normalized ${memoryLimit === null ? "within this workload" : "against configured per-pod limits"}.`;

  return (
    <div className="mt-5 space-y-5">
      <section
        className="border-t border-ink-700 pt-4"
        aria-label={
          usage.length > 0
            ? `Current workload metrics snapshot. ${normalization}`
            : "Current workload metrics snapshot"
        }
      >
        <h3 className="text-xs font-semibold text-ink-100">
          Current metrics snapshot
        </h3>
        {usage.length > 0 ? (
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div>
              <h4 className="text-2xs font-medium uppercase text-ink-400">
                CPU
              </h4>
              <div className="mt-1 divide-y divide-ink-700">
                {usagePagination.pageItems.map((row) => (
                  <MetricBar
                    row={row}
                    field="cpu"
                    maximum={cpuMaximum}
                    key={`cpu:${row.namespace}:${row.name}`}
                  />
                ))}
              </div>
            </div>
            <div>
              <h4 className="text-2xs font-medium uppercase text-ink-400">
                Memory
              </h4>
              <div className="mt-1 divide-y divide-ink-700">
                {usagePagination.pageItems.map((row) => (
                  <MetricBar
                    row={row}
                    field="memory"
                    maximum={memoryMaximum}
                    key={`memory:${row.namespace}:${row.name}`}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <p role="status" className="mt-3 text-xs text-ink-400">
            {metricsStatus === "available" || metricsStatus === "stale"
              ? "No current pod samples for this workload."
              : "Metrics API unavailable."}
          </p>
        )}
        <Pagination state={usagePagination} />
      </section>
      {pods.length > 0 && (
        <section
          className="border-t border-ink-700 pt-4"
          aria-label="Related pods"
        >
          <h3 className="text-xs font-semibold text-ink-100">Related pods</h3>
          <div className="mt-3 overflow-x-auto" tabIndex={0}>
            <div className="min-w-[28rem]">
              <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(5rem,0.7fr)_minmax(7rem,1fr)_5rem] gap-3 border-b border-ink-700 pb-2 text-2xs font-medium uppercase text-ink-400">
                <span>Pod</span>
                <span>Status</span>
                <span>Node</span>
                <span className="text-right">Restarts</span>
              </div>
              <div className="divide-y divide-ink-700">
                {podPagination.pageItems.map((pod) => (
                  <div
                    className="grid grid-cols-[minmax(0,1.4fr)_minmax(5rem,0.7fr)_minmax(7rem,1fr)_5rem] gap-3 py-2 text-xs"
                    key={pod.name}
                  >
                    <span
                      className="truncate font-medium text-ink-100"
                      title={pod.name}
                    >
                      {pod.name}
                    </span>
                    <span className="truncate text-ink-300">
                      {pod.phase || "Unknown"}
                    </span>
                    <span className="truncate text-ink-300" title={pod.node}>
                      {pod.node || "Unassigned"}
                    </span>
                    <span className="text-right tabular-nums text-ink-300">
                      {pod.restart_count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <Pagination state={podPagination} />
        </section>
      )}
    </div>
  );
}

const workloadSummaryKeys = new Set([
  "desired",
  "ready",
  "available",
  "unavailable",
  "updatestrategy",
  "generation",
]);

function ResourceDetail({
  resource,
  related,
  eventCount,
  workload,
}: {
  resource: KubernetesResource;
  related?: Array<{
    resource_id?: string;
    kind: string;
    namespace?: string;
    name: string;
  }> | null;
  eventCount: number;
  workload?: Awaited<ReturnType<typeof api.kubernetesWorkload>>;
}) {
  const summary = Object.entries(resource.summary ?? {}).filter(
    ([key, value]) =>
      (value === null ||
        ["string", "number", "boolean"].includes(typeof value)) &&
      (!workload ||
        !workloadSummaryKeys.has(key.replaceAll("_", "").toLowerCase())),
  );
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-3">
        <PeekField label="Kind">{resource.kind}</PeekField>
        <PeekField label="Namespace">
          {resource.namespace || "Cluster scope"}
        </PeekField>
        <PeekField label="API version">
          {resource.api_version || "Unavailable"}
        </PeekField>
        <PeekField label="Events">{eventCount}</PeekField>
      </dl>
      {workload && (
        <section className="border-y border-ink-700 py-4">
          <h3 className="text-xs font-semibold text-ink-100">
            Workload status
          </h3>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            <PeekField label="Desired">{workload.desired ?? "n/a"}</PeekField>
            <PeekField label="Ready">{workload.ready ?? "n/a"}</PeekField>
            <PeekField label="Available">
              {workload.available ?? "n/a"}
            </PeekField>
            <PeekField label="Unavailable">
              {workload.unavailable ?? "n/a"}
            </PeekField>
            <PeekField label="Strategy">
              {workload.update_strategy ?? "n/a"}
            </PeekField>
            <PeekField label="Generation">
              {workload.generation ?? "n/a"}
            </PeekField>
          </dl>
        </section>
      )}
      {summary.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-ink-100">Information</h3>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
            {summary.map(([key, value]) => (
              <PeekField label={readable(key)} key={key}>
                {value === null ? "n/a" : String(value)}
              </PeekField>
            ))}
          </dl>
        </section>
      )}
      {asArray(resource.conditions).length > 0 && (
        <section className="border-t border-ink-700 pt-4">
          <h3 className="text-xs font-semibold text-ink-100">Conditions</h3>
          <div className="mt-2 divide-y divide-ink-700">
            {asArray(resource.conditions).map((condition) => (
              <div
                className="flex items-center justify-between gap-3 py-2 text-xs"
                key={condition.type}
              >
                <span className="text-ink-200">{condition.type}</span>
                <span
                  className={
                    condition.status === "True"
                      ? "text-sev-ok"
                      : "text-sev-warning"
                  }
                >
                  {condition.status}
                  {condition.reason ? ` · ${condition.reason}` : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {asArray(related).length > 0 && (
        <section className="border-t border-ink-700 pt-4">
          <h3 className="text-xs font-semibold text-ink-100">
            Related resources
          </h3>
          <div className="mt-2 space-y-2">
            {asArray(related).map((item) => (
              <div
                className="flex items-center justify-between gap-3 text-xs"
                key={`${item.resource_id}:${item.namespace}:${item.name}`}
              >
                <span className="truncate text-ink-200">{item.name}</span>
                <span className="pill">{item.kind}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {resource.projection_truncated?.length ? (
        <p role="status" className="text-xs text-sev-warning">
          Projection truncated: {resource.projection_truncated.join(", ")}
        </p>
      ) : null}
    </div>
  );
}
