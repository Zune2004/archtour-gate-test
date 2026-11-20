import { SQL_RECOMMENDED_RULES } from "./facts-sql.mjs";
import { TERRAFORM_RULES } from "./facts-terraform.mjs";
// Archtour Recommended Rules Pack (archtour:recommended)
// Default architecture guardrails library providing day-one value without writing rules.

const BASE_RECOMMENDED_RULES = [
  {
    id: "no-privileged-containers",
    on: "service.privileged_enabled",
    level: "hard",
    adjustable: false,
    owners: [],
    message: "Privileged containers are not allowed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "no-docker-socket-mount",
    on: "service.docker_socket_mounted",
    level: "hard",
    adjustable: false,
    owners: [],
    message: "Mounting the Docker socket (/var/run/docker.sock) is not allowed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "no-host-network",
    on: "service.host_network_enabled",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Host network mode should not be used in services.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "no-all-interfaces-port-binding",
    on: ["service.port_published", "compose.port_exposed"],
    level: "soft",
    adjustable: true,
    owners: [],
    where: { environment: "!dev" },
    message: "Publishing ports bound to all interfaces should be avoided.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "no-external-registry",
    on: "service.registry_changed",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Container registry changed to an external or untrusted registry.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "service-image-changed",
    on: "service.image_changed",
    level: "advisory",
    adjustable: true,
    owners: [],
    message: "Container image changed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "no-db-model-removed",
    on: "db.model_removed",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Database model was removed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "db-model-renamed",
    on: "db.model_renamed",
    level: "advisory",
    adjustable: true,
    owners: [],
    message: "Database model was renamed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "no-db-field-removed",
    on: "db.field_removed",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Database field was removed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "db-field-renamed",
    on: "db.field_renamed",
    level: "advisory",
    adjustable: true,
    owners: [],
    message: "Database field was renamed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "db-field-type-changed",
    on: "db.field_type_changed",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Database field type was changed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "db-field-made-required",
    on: "db.field_made_required",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Database field was changed from optional to required.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "no-api-route-removed",
    on: "api.route_removed",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "API route was removed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "no-api-param-required-added",
    on: "api.param_required_added",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "New required parameter added to API route.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "no-api-request-required-added",
    on: "api.request_required_added",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "New required request body property added to API route.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "no-api-security-removed",
    on: "api.security_removed",
    level: "hard",
    adjustable: false,
    owners: [],
    message: "Security requirement removed from API route.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "api-new-route-public",
    on: "api.route_public",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "New API route is public (no security).",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    id: "service-dependency-added",
    on: "service.dependency_added",
    level: "advisory",
    adjustable: true,
    owners: [],
    message: "New service dependency added.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  },
  {
    // `check` pushes this finding directly when the scan hits --max-files; no diff event is ever emitted, so `on` is
    // only schema metadata (validateRule requires it). The entry keeps the rule id, level and "not adjustable" flag in
    // `archtour rules` output and in the override resolver's rule list. Never overridable: the finding is hard.
    id: "scan-truncated",
    on: "scan.truncated",
    level: "hard",
    adjustable: false,
    owners: [],
    message: "Scan was truncated before examining all candidate files; raise --max-files. Not overridable.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#3-built-in-pack-archtourrecommended"
  }
];

export const K8S_RULES = [
  {
    id: "no-k8s-privileged-containers",
    on: "k8s.privileged_enabled",
    level: "hard",
    adjustable: false,
    owners: [],
    message: "Privileged containers are not allowed in Kubernetes workloads.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  },
  {
    id: "no-k8s-host-network-or-pid",
    on: ["k8s.host_network_enabled", "k8s.host_pid_enabled"],
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Host network and host PID should not be used in Kubernetes workloads.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  },
  {
    id: "no-k8s-host-path-mount",
    on: "k8s.host_path_added",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Mounting hostPath volumes in Kubernetes containers should be avoided.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  },
  {
    id: "no-k8s-run-as-root",
    on: "k8s.run_as_root",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Containers in Kubernetes should not run as root.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  },
  {
    id: "no-k8s-privilege-escalation",
    on: "k8s.privilege_escalation_allowed",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Allowing privilege escalation in Kubernetes containers should be avoided.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  },
  {
    id: "no-k8s-capability-added",
    on: "k8s.capability_added",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Adding Linux capabilities to Kubernetes containers should be reviewed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  },
  {
    id: "no-k8s-service-exposed",
    on: "k8s.service_exposed",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Exposing Kubernetes services via LoadBalancer or NodePort requires review.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  },
  {
    id: "no-k8s-ingress-tls-removed",
    on: "k8s.ingress_tls_removed",
    level: "hard",
    adjustable: false,
    owners: [],
    message: "Removing TLS configuration from Kubernetes Ingress is not allowed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  },
  {
    id: "k8s-ingress-host-added",
    on: "k8s.ingress_host_added",
    level: "advisory",
    adjustable: true,
    owners: [],
    message: "New host added to Kubernetes Ingress.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  },
  {
    id: "no-k8s-external-registry",
    on: "k8s.registry_changed",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Container registry changed in Kubernetes workload.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  },
  {
    id: "no-k8s-limits-removed",
    on: "k8s.limits_removed",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Resource limits were removed from a Kubernetes container.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  },
  {
    id: "k8s-limits-missing-new",
    on: "k8s.limits_missing_new",
    level: "advisory",
    adjustable: true,
    owners: [],
    message: "New Kubernetes container defined without resource limits.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#kubernetes"
  }
];

export const GRAPHQL_PROTO_RULES = [
  {
    id: "gql-breaking",
    on: "gql.breaking",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "GraphQL schema breaking change detected.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#graphql"
  },
  {
    id: "gql-dangerous",
    on: "gql.dangerous",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "GraphQL schema dangerous change detected.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#graphql"
  },
  {
    id: "proto-field-number-reused",
    on: "proto.field_number_reused",
    level: "hard",
    adjustable: false,
    owners: [],
    message: "Protobuf field number was reused.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#protobuf--grpc"
  },
  {
    id: "proto-field-number-changed",
    on: "proto.field_number_changed",
    level: "hard",
    adjustable: false,
    owners: [],
    message: "Protobuf field number was changed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#protobuf--grpc"
  },
  {
    id: "proto-field-removed",
    on: "proto.field_removed",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Protobuf field was removed without reserving its field number.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#protobuf--grpc"
  },
  {
    id: "proto-field-type-changed",
    on: "proto.field_type_changed",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "Protobuf field type was changed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#protobuf--grpc"
  },
  {
    id: "proto-rpc-removed",
    on: "proto.rpc_removed",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "gRPC RPC method was removed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#protobuf--grpc"
  },
  {
    id: "proto-rpc-signature-changed",
    on: "proto.rpc_signature_changed",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "gRPC RPC signature was changed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#protobuf--grpc"
  },
  {
    id: "proto-service-removed",
    on: "proto.service_removed",
    level: "soft",
    adjustable: true,
    owners: [],
    message: "gRPC service was removed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#protobuf--grpc"
  },
  {
    id: "proto-enum-value-removed",
    on: "proto.enum_value_removed",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Protobuf enum value was removed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#protobuf--grpc"
  },
  {
    id: "proto-package-changed",
    on: "proto.package_changed",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Protobuf package was changed.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#protobuf--grpc"
  },
  {
    id: "proto-required-added",
    on: "proto.required_added",
    level: "warn",
    adjustable: true,
    owners: [],
    message: "Required protobuf field was added.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#protobuf--grpc"
  }
];

export const PARSE_ERROR_RULES = [
  {
    id: "parse-error-head",
    on: ["parse.error_head", "parse-error-head"],
    level: "soft",
    adjustable: true,
    owners: [],
    message: "File that parsed in base failed to parse in head.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#parse-errors"
  },
  {
    id: "parse-error-new-file",
    on: ["parse.error_new_file", "parse-error-new-file"],
    level: "soft",
    adjustable: true,
    owners: [],
    message: "New candidate file failed to parse.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#parse-errors"
  },
  {
    id: "parse-error-unchanged",
    on: ["parse.error_unchanged", "parse-error-unchanged"],
    level: "warn",
    adjustable: true,
    owners: [],
    message: "File failed to parse in both base and head.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#parse-errors"
  },
  {
    id: "file-not-checked",
    on: ["file.not_checked", "file-not-checked"],
    level: "advisory",
    adjustable: true,
    owners: [],
    message: "Candidate architecture file was not checked.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#file-not-checked"
  },
  {
    id: "changed-file-not-checked",
    on: ["file.not_checked"],
    level: "soft",
    adjustable: true,
    owners: [],
    message: "A new or changed architecture file was not checked (render templates or split the file), so its rules did not run.",
    docs: "https://github.com/Zune2004/archtour/blob/main/docs/GUARDRAILS.md#file-not-checked"
  }
];

export { TERRAFORM_RULES };

// The built-in pack: core rules first, then one block per supported format.
export const RECOMMENDED_RULES = [
  ...BASE_RECOMMENDED_RULES,
  ...SQL_RECOMMENDED_RULES,
  ...K8S_RULES,
  ...GRAPHQL_PROTO_RULES,
  ...TERRAFORM_RULES,
  ...PARSE_ERROR_RULES
];
