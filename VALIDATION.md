# Validation record

Base repository commit: f5a5bf3 (July 2, 2026).
Updated locally October 16, 2026.

## Completed

- Dependency installation and TypeScript compilation.
- Pulumi mock checks in LoadBalancer and NodePort modes.
- Secret propagation into the Helm release values and exported password.
- Monitoring URLs, ServiceMonitor metrics port, pinned image references and chart versions.
- Explicit Redis replica configuration and leader-only key-count dashboard query.
- Image digest existence verified against Docker Hub; chart versions verified against the official Helm repository.

## Live deployment still required

This environment has no configured Kubernetes context. Mock checks are not deployment evidence.

1. Use an isolated Kubernetes 1.25+ cluster with sufficient resources for kube-prometheus-stack.
2. Run npm ci, create/select a Pulumi stack, and configure a secret Grafana password.
3. For a local cluster, set isMinikube=true. Run pulumi up.
4. Check all workloads:

```bash
kubectl get pods -n monitoring
kubectl get pods -n guestbook
kubectl get deployments -n guestbook
kubectl get servicemonitor,probe -n guestbook
kubectl exec -n guestbook deploy/redis-replica -c replica -- redis-cli INFO replication
```

The replica should report role:slave and master_link_status:up (Redis uses these field values).
Inspect failing pods/events before continuing.

5. Open Guestbook, add an entry, refresh, and verify it remains visible. This exercises the frontend, leader writes, replica reads and replication.
6. Port-forward Prometheus as described in README. In its UI, verify targets are UP and run:

```promql
redis_up{namespace="guestbook"}
probe_success{job="guestbook-frontend-blackbox"}
redis_connected_clients{namespace="guestbook"}
rate(redis_commands_processed_total{namespace="guestbook"}[5m])
sum(redis_db_keys{namespace="guestbook",service="redis-leader"})
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook",pod=~"frontend.*",container="frontend"}[5m]))
```

redis_up and probe_success must equal 1. Wait at least five minutes for rate panels.

7. Retrieve Grafana outputs, sign in, and open the provisioned Guestbook dashboard. Check all panels contain appropriate data. Save screenshots of targets and dashboard after successful checks; do not include passwords.
8. Record Kubernetes, Pulumi and Node versions, deployment date, and the result of each check here.
9. Run pulumi destroy after collecting evidence if the test cluster is no longer needed.

## Changes made

- Secret-aware Grafana configuration.
- Exact Helm chart versions, application image digests and npm lockfile.
- Shared Redis image for leader and replica with explicit replication arguments.
- Real dependency from blackbox probe URL to the exporter release.
- Leader-only Redis key metric, corrected title and frontend-container resource filters.
- Automated mock checks and honest deployment validation instructions.
