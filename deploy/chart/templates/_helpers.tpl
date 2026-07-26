{{- define "k8s-incident-triage.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "k8s-incident-triage.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "k8s-incident-triage.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "k8s-incident-triage.selectorLabels" -}}
app.kubernetes.io/name: {{ include "k8s-incident-triage.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "k8s-incident-triage.labels" -}}
helm.sh/chart: {{ include "k8s-incident-triage.chart" . }}
{{ include "k8s-incident-triage.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "k8s-incident-triage.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "k8s-incident-triage.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- required "serviceAccount.name is required when serviceAccount.create=false" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "k8s-incident-triage.clusterRoleName" -}}
{{- printf "%s-%s-readonly" (include "k8s-incident-triage.fullname" .) .Release.Namespace | trunc 253 | trimSuffix "-" -}}
{{- end -}}

{{- define "k8s-incident-triage.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "k8s-incident-triage.secretName" -}}
{{- default (include "k8s-incident-triage.fullname" .) .Values.secrets.existingSecret -}}
{{- end -}}
