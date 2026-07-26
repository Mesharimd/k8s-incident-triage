export const KUBERNETES_DNS_LABEL_MAX_LENGTH = 63;
export const KUBERNETES_DNS_SUBDOMAIN_MAX_LENGTH = 253;

export const KUBERNETES_DNS_LABEL_PATTERN =
  "^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$";
export const KUBERNETES_DNS_SUBDOMAIN_PATTERN =
  "^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$";

const DNS_LABEL = new RegExp(KUBERNETES_DNS_LABEL_PATTERN);
const DNS_SUBDOMAIN = new RegExp(KUBERNETES_DNS_SUBDOMAIN_PATTERN);

export function isKubernetesDnsLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= KUBERNETES_DNS_LABEL_MAX_LENGTH &&
    DNS_LABEL.test(value)
  );
}

export function isKubernetesDnsSubdomain(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= KUBERNETES_DNS_SUBDOMAIN_MAX_LENGTH &&
    DNS_SUBDOMAIN.test(value)
  );
}
