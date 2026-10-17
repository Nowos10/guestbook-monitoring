const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const pulumi = require("@pulumi/pulumi");

require.extensions[".ts"] = (mod, filename) => {
    const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    mod._compile(source.outputText, filename);
};

const resources = [];
let resolveReady;
const ready = new Promise(resolve => { resolveReady = resolve; });
const nodePort = process.argv.includes("--nodeport");
pulumi.runtime.setMocks({
    newResource(args) {
        resources.push(args);
        if (["frontend-probe", "redis-servicemonitor", "frontend", "redis-leader", "redis-replica", "guestbook-dashboard"].every(name => resources.some(r => r.name === name))) resolveReady();
        const state = { ...args.inputs };
        if (args.type === "kubernetes:core/v1:Namespace") {
            state.metadata = { ...state.metadata, name: args.name };
        }
        if (args.type === "kubernetes:helm.sh/v3:Release") {
            state.status = { name: args.inputs.name, namespace: "monitoring" };
        }
        if (args.type === "kubernetes:core/v1:Service") {
            state.status = { loadBalancer: { ingress: [{ ip: "192.0.2.10" }] } };
            state.spec = state.spec || { ports: [{ port: 80, nodePort: 30080 }] };
        }
        return { id: args.id || args.name + "-id", state };
    },
    call(args) { return args.inputs; },
}, "guestbook-monitoring", "test", false);
pulumi.runtime.setAllConfig({
    "guestbook-monitoring:grafanaAdminPassword": "test-only-password",
    "guestbook-monitoring:isMinikube": String(nodePort),
}, ["guestbook-monitoring:grafanaAdminPassword"]);

(async () => {
    await pulumi.runtime.runInPulumiStack(async () => {
        const app = require("../index.ts");
        assert.equal(await pulumi.isSecret(app.grafanaAdminPassword), true);
        assert.equal(await app.grafanaAdminPassword.promise(), "test-only-password");
        const url = await app.grafanaUrl.promise();
        await ready;
        assert.ok(nodePort ? url.includes(":30080") : url === "http://192.0.2.10");
        // Resolving the exported URL also waits for the Helm inputs.
        const stack = resources.find(r => r.name === "kube-prometheus-stack");
        assert.equal(stack.inputs.version, "92.10.1");
        assert.equal(stack.inputs.values[pulumi.runtime.specialSigKey],
            pulumi.runtime.specialSecretSig);
        assert.equal(stack.inputs.values.value.grafana.service.type, nodePort ? "NodePort" : "LoadBalancer");
        const blackbox = resources.find(r => r.name === "blackbox-exporter");
        assert.equal(blackbox.inputs.version, "11.20.0");
        const probe = resources.find(r => r.name === "frontend-probe");
        assert.equal(probe.inputs.spec.prober.url, "blackbox-exporter.monitoring.svc.cluster.local:9115");
        assert.equal(probe.inputs.spec.targets.staticConfig.static[0],
            "http://frontend.guestbook.svc.cluster.local:80");
        const monitor = resources.find(r => r.name === "redis-servicemonitor");
        assert.equal(monitor.inputs.spec.endpoints[0].port, "metrics");
        const deployments = resources.filter(r => r.type === "kubernetes:apps/v1:Deployment");
        for (const d of deployments) {
            for (const c of d.inputs.spec.template.spec.containers) {
                assert.match(c.image, /@sha256:[a-f0-9]{64}$/);
            }
        }
        const replica = deployments.find(r => r.name === "redis-replica");
        assert.deepEqual(replica.inputs.spec.template.spec.containers[0].args,
            ["redis-server", "--replicaof", "redis-leader", "6379"]);
        const dashboard = JSON.parse(fs.readFileSync("dashboards/guestbook-dashboard.json"));
        const keys = dashboard.panels.find(p => p.id === 10);
        assert.ok(keys.targets[0].expr.includes('service="redis-leader"'));
        console.log("PASS: " + (nodePort ? "NodePort" : "LoadBalancer") +
            " resource wiring, secret propagation, pinned versions, replica and dashboard checks");
        return {};
    });
})().catch(err => { console.error(err); process.exitCode = 1; });



