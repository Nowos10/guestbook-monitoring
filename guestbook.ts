// guestbook.ts
//
// A port of the canonical Pulumi "simple" Kubernetes Guestbook
// (https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook/simple)
// extended for observability:
//
//   * redis-exporter sidecars on the redis-leader and redis-replica pods so the
//     backend exposes Prometheus metrics on :9121 (commands processed, connected
//     clients, keyspace, memory, etc.).
//   * A `metrics` port on each redis Service.
//   * ServiceMonitor CRs (Prometheus Operator) so Prometheus scrapes those exporters.
//   * A blackbox Probe CR targeting the frontend Service. The frontend image
//     (pulumi/guestbook-php-redis) exposes NO native /metrics endpoint, so we
//     monitor it the way an SRE monitors any opaque/3rd-party service: black-box
//     HTTP probing (availability, latency, status code). Per-pod CPU/memory for
//     the frontend comes for free from cAdvisor via kube-prometheus-stack.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const REDIS_EXPORTER_IMAGE = "oliver006/redis_exporter:v1.62.0";
const REDIS_EXPORTER_PORT = 9121;

export interface GuestbookArgs {
    provider: k8s.Provider;
    namespace: pulumi.Input<string>;
    // Expose frontend as LoadBalancer (cloud) or NodePort (minikube).
    frontendServiceType: pulumi.Input<string>;
    // The Helm release that installs the Prometheus Operator CRDs
    // (ServiceMonitor, Probe). Our CRs must be created *after* it so the CRDs exist.
    crdDependency: pulumi.Resource;
    // Cluster-internal DNS name:port of the blackbox-exporter service.
    blackboxProberUrl: pulumi.Input<string>;
}

export interface GuestbookResult {
    frontendService: k8s.core.v1.Service;
}

export function deployGuestbook(args: GuestbookArgs): GuestbookResult {
    const { provider, namespace, frontendServiceType, crdDependency, blackboxProberUrl } = args;
    const opts = { provider };

    // -------------------------------------------------------------------------
    // REDIS LEADER (single instance, stores writes) + redis-exporter sidecar
    // -------------------------------------------------------------------------
    const redisLeaderLabels = { app: "redis-leader" };
    const redisLeader = new k8s.apps.v1.Deployment("redis-leader", {
        metadata: { namespace, labels: redisLeaderLabels },
        spec: {
            selector: { matchLabels: redisLeaderLabels },
            template: {
                metadata: { labels: redisLeaderLabels },
                spec: {
                    containers: [
                        {
                            name: "redis-leader",
                            image: "redis",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            ports: [{ name: "redis", containerPort: 6379 }],
                        },
                        redisExporterSidecar(),
                    ],
                },
            },
        },
    }, opts);

    const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
        metadata: { name: "redis-leader", namespace, labels: redisLeaderLabels },
        spec: {
            ports: [
                { name: "redis", port: 6379, targetPort: 6379 },
                { name: "metrics", port: REDIS_EXPORTER_PORT, targetPort: REDIS_EXPORTER_PORT },
            ],
            selector: redisLeaderLabels,
        },
    }, opts);

    // -------------------------------------------------------------------------
    // REDIS REPLICA (scaled reads) + redis-exporter sidecar
    // -------------------------------------------------------------------------
    const redisReplicaLabels = { app: "redis-replica" };
    const redisReplica = new k8s.apps.v1.Deployment("redis-replica", {
        metadata: { namespace, labels: redisReplicaLabels },
        spec: {
            selector: { matchLabels: redisReplicaLabels },
            template: {
                metadata: { labels: redisReplicaLabels },
                spec: {
                    containers: [
                        {
                            name: "replica",
                            image: "pulumi/guestbook-redis-replica",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            // Use DNS to find the leader. Switch to "env" if your
                            // cluster has no DNS add-on.
                            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                            ports: [{ name: "redis", containerPort: 6379 }],
                        },
                        redisExporterSidecar(),
                    ],
                },
            },
        },
    }, opts);

    const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
        metadata: { name: "redis-replica", namespace, labels: redisReplicaLabels },
        spec: {
            ports: [
                { name: "redis", port: 6379, targetPort: 6379 },
                { name: "metrics", port: REDIS_EXPORTER_PORT, targetPort: REDIS_EXPORTER_PORT },
            ],
            selector: redisReplicaLabels,
        },
    }, opts);

    // -------------------------------------------------------------------------
    // FRONTEND (PHP + Redis guestbook UI)
    // -------------------------------------------------------------------------
    const frontendLabels = { app: "frontend" };
    const frontend = new k8s.apps.v1.Deployment("frontend", {
        metadata: { namespace, labels: frontendLabels },
        spec: {
            selector: { matchLabels: frontendLabels },
            replicas: 3,
            template: {
                metadata: { labels: frontendLabels },
                spec: {
                    containers: [
                        {
                            name: "frontend",
                            image: "pulumi/guestbook-php-redis",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                            ports: [{ name: "http", containerPort: 80 }],
                        },
                    ],
                },
            },
        },
    }, opts);

    const frontendService = new k8s.core.v1.Service("frontend", {
        metadata: { name: "frontend", namespace, labels: frontendLabels },
        spec: {
            type: frontendServiceType,
            ports: [{ name: "http", port: 80, targetPort: 80 }],
            selector: frontendLabels,
        },
    }, opts);

    // -------------------------------------------------------------------------
    // PROMETHEUS OPERATOR CUSTOM RESOURCES
    // These depend on the kube-prometheus-stack release because it installs the
    // ServiceMonitor / Probe CRDs.
    // -------------------------------------------------------------------------
    const crOpts = { provider, dependsOn: [crdDependency] };

    // ServiceMonitor: scrape the redis-exporter `metrics` port on both services.
    // A single ServiceMonitor matches both redis Services via the shared
    // `monitored-by: guestbook` label we add through matchExpressions on `app`.
    new k8s.apiextensions.CustomResource("redis-servicemonitor", {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
            name: "guestbook-redis",
            namespace,
            labels: { release: "kube-prometheus-stack" },
        },
        spec: {
            namespaceSelector: { matchNames: [namespace] },
            selector: {
                matchExpressions: [
                    { key: "app", operator: "In", values: ["redis-leader", "redis-replica"] },
                ],
            },
            endpoints: [
                { port: "metrics", interval: "15s", path: "/metrics" },
            ],
        },
    }, crOpts);

    // Probe: black-box HTTP monitoring of the frontend Service. Gives us
    // probe_success (availability), probe_http_duration_seconds (latency),
    // and probe_http_status_code without instrumenting the PHP app.
    new k8s.apiextensions.CustomResource("frontend-probe", {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "Probe",
        metadata: {
            name: "guestbook-frontend",
            namespace,
            labels: { release: "kube-prometheus-stack" },
        },
        spec: {
            jobName: "guestbook-frontend-blackbox",
            interval: "30s",
            module: "http_2xx",
            prober: { url: blackboxProberUrl },
            targets: {
                staticConfig: {
                    // Cluster-internal DNS of the frontend Service.
                    static: [pulumi.interpolate`http://frontend.${namespace}.svc.cluster.local:80`],
                    labels: { app: "frontend", tier: "frontend" },
                },
            },
        },
    }, crOpts);

    return { frontendService };
}

// Shared redis-exporter sidecar definition. It connects to redis on
// localhost:6379 (same pod) and serves Prometheus metrics on :9121.
function redisExporterSidecar(): k8s.types.input.core.v1.Container {
    return {
        name: "redis-exporter",
        image: REDIS_EXPORTER_IMAGE,
        args: ["--redis.addr=redis://localhost:6379"],
        resources: { requests: { cpu: "25m", memory: "32Mi" } },
        ports: [{ name: "metrics", containerPort: REDIS_EXPORTER_PORT }],
    };
}
