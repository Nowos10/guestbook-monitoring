// index.ts — entrypoint.
//
// Order of operations:
//   1. Create the `monitoring` and `guestbook` namespaces.
//   2. Install kube-prometheus-stack (Prometheus Operator + CRDs + Grafana) and
//      the blackbox exporter.
//   3. Deploy the Guestbook app + its ServiceMonitor/Probe (after the CRDs exist).
//   4. Export Grafana access details and the frontend URL.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { deployMonitoring } from "./monitoring";
import { deployGuestbook } from "./guestbook";

const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube") ?? false;
const adminUser = "admin";
const adminPassword = config.get("grafanaAdminPassword") ?? "prom-operator";

// On minikube (no cloud LoadBalancer) fall back to NodePort.
const externalServiceType = isMinikube ? "NodePort" : "LoadBalancer";

// Use the ambient kubeconfig (whatever `kubectl config current-context` points at).
const provider = new k8s.Provider("k8s", {});

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------
const monitoringNs = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
}, { provider });

const guestbookNs = new k8s.core.v1.Namespace("guestbook", {
    metadata: { name: "guestbook" },
}, { provider });

// ---------------------------------------------------------------------------
// Monitoring stack
// ---------------------------------------------------------------------------
const monitoring = deployMonitoring({
    provider,
    namespace: monitoringNs.metadata.name,
    namespaceResource: monitoringNs,
    grafanaServiceType: externalServiceType,
    grafanaAdminUser: adminUser,
    grafanaAdminPassword: adminPassword,
});

// ---------------------------------------------------------------------------
// Guestbook application (+ ServiceMonitor / Probe)
// ---------------------------------------------------------------------------
const guestbook = deployGuestbook({
    provider,
    namespace: guestbookNs.metadata.name,
    frontendServiceType: externalServiceType,
    crdDependency: monitoring.stackRelease,
    blackboxProberUrl: monitoring.blackboxProberUrl,
});

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
export const grafanaUrl = monitoring.grafanaUrl;
export const grafanaAdminUser = pulumi.output(adminUser);
export const grafanaAdminPassword = pulumi.secret(adminPassword);

// Frontend (Guestbook UI) URL.
export const guestbookFrontendUrl = guestbook.frontendService.status.apply(s => {
    if (externalServiceType === "NodePort") {
        return "minikube: run `minikube service frontend -n guestbook --url`";
    }
    const ing = s.loadBalancer?.ingress?.[0];
    if (!ing) {
        return "PENDING — run: kubectl get svc -n guestbook frontend";
    }
    return `http://${ing.ip ?? ing.hostname}`;
});
