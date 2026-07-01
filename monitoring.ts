// monitoring.ts
//
// Installs the observability stack and wires Grafana access outputs.
//
//   * kube-prometheus-stack -> Prometheus Operator, Prometheus, Alertmanager,
//     Grafana, node-exporter, kube-state-metrics. We flip the
//     *SelectorNilUsesHelmValues flags to false so Prometheus discovers OUR
//     ServiceMonitors/Probes cluster-wide (the #1 reason custom targets silently
//     don't get scraped).
//   * prometheus-blackbox-exporter -> probes the opaque PHP frontend.
//   * A ConfigMap (label grafana_dashboard=1) the Grafana sidecar auto-imports.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";

const STACK_RELEASE = "kube-prometheus-stack";
const PROM_HELM_REPO = "https://prometheus-community.github.io/helm-charts";

export interface MonitoringArgs {
    provider: k8s.Provider;
    namespace: pulumi.Input<string>;
    namespaceResource: k8s.core.v1.Namespace;
    grafanaServiceType: string;        // "LoadBalancer" | "NodePort"
    grafanaAdminUser: pulumi.Input<string>;
    grafanaAdminPassword: pulumi.Input<string>;
}

export interface MonitoringResult {
    stackRelease: k8s.helm.v3.Release;
    blackboxProberUrl: pulumi.Output<string>;
    grafanaUrl: pulumi.Output<string>;
}

export function deployMonitoring(args: MonitoringArgs): MonitoringResult {
    const {
        provider, namespace, namespaceResource,
        grafanaServiceType, grafanaAdminUser, grafanaAdminPassword,
    } = args;
    const opts = { provider };

    // -------------------------------------------------------------------------
    // kube-prometheus-stack
    // -------------------------------------------------------------------------
    const stackRelease = new k8s.helm.v3.Release(STACK_RELEASE, {
        name: STACK_RELEASE,           // fixed name -> predictable service names
        namespace,
        chart: "kube-prometheus-stack",
        // version: "75.x.x",          // RECOMMENDED: pin in real use. Omitted -> latest.
        repositoryOpts: { repo: PROM_HELM_REPO },
        values: {
            grafana: {
                adminUser: grafanaAdminUser,
                adminPassword: grafanaAdminPassword,
                service: { type: grafanaServiceType },
                sidecar: {
                    dashboards: {
                        enabled: true,
                        label: "grafana_dashboard",
                        searchNamespace: "ALL",
                    },
                },
            },
            prometheus: {
                prometheusSpec: {
                    // Discover ServiceMonitors/PodMonitors/Probes/Rules in ALL
                    // namespaces regardless of labels.
                    serviceMonitorSelectorNilUsesHelmValues: false,
                    podMonitorSelectorNilUsesHelmValues: false,
                    probeSelectorNilUsesHelmValues: false,
                    ruleSelectorNilUsesHelmValues: false,
                },
            },
        },
    }, { ...opts, dependsOn: [namespaceResource] });

    // -------------------------------------------------------------------------
    // blackbox exporter (for the frontend Probe)
    // -------------------------------------------------------------------------
    const blackbox = new k8s.helm.v3.Release("blackbox-exporter", {
        name: "blackbox-exporter",
        namespace,
        chart: "prometheus-blackbox-exporter",
        repositoryOpts: { repo: PROM_HELM_REPO },
        values: {
            fullnameOverride: "blackbox-exporter",   // -> service "blackbox-exporter:9115"
        },
    }, { ...opts, dependsOn: [namespaceResource] });

    const blackboxProberUrl = pulumi
        .all([namespace])
        .apply(([ns]) => `blackbox-exporter.${ns}.svc.cluster.local:9115`);
    // Keep a dependency edge on the blackbox release.
    blackbox.status.apply(() => undefined);

    // -------------------------------------------------------------------------
    // Grafana dashboard (stretch goal) provisioned via labeled ConfigMap
    // -------------------------------------------------------------------------
    const dashboardJson = fs.readFileSync(
        path.join(__dirname, "dashboards", "guestbook-dashboard.json"),
        "utf8",
    );
    new k8s.core.v1.ConfigMap("guestbook-dashboard", {
        metadata: {
            namespace,
            labels: { grafana_dashboard: "1" },
        },
        data: { "guestbook-dashboard.json": dashboardJson },
    }, { ...opts, dependsOn: [stackRelease] });

    // -------------------------------------------------------------------------
    // Grafana access URL
    // -------------------------------------------------------------------------
    const grafanaService = k8s.core.v1.Service.get(
        "grafana-lookup",
        pulumi.interpolate`${namespace}/${STACK_RELEASE}-grafana`,
        { ...opts, dependsOn: [stackRelease] },
    );

    let grafanaUrl: pulumi.Output<string>;
    if (grafanaServiceType === "LoadBalancer") {
        grafanaUrl = grafanaService.status.apply(s => {
            const ing = s.loadBalancer?.ingress?.[0];
            if (!ing) {
                return "PENDING — external IP not yet assigned. " +
                    "Run: kubectl get svc -n monitoring kube-prometheus-stack-grafana";
            }
            const host = ing.ip ?? ing.hostname;
            return `http://${host}`;
        });
    } else {
        // NodePort (minikube et al.)
        grafanaUrl = grafanaService.spec.apply(s => {
            const np = s.ports?.find(p => p.port === 80)?.nodePort ?? s.ports?.[0]?.nodePort;
            return `http://<node-ip>:${np}  ` +
                `(minikube: run \`minikube service ${STACK_RELEASE}-grafana -n monitoring --url\`)`;
        });
    }

    return { stackRelease, blackboxProberUrl, grafanaUrl };
}
