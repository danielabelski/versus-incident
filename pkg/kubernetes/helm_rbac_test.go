package kubernetes

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestKubernetesReaderRBACTemplateIsReadOnly(t *testing.T) {
	template, err := os.ReadFile("../../helm/versus-incident/templates/kubernetes-reader-rbac.yaml")
	if err != nil {
		t.Fatal(err)
	}
	content := string(template)
	verbs := quotedTemplateFieldValues(t, content, "verbs")
	resources := quotedTemplateFieldValues(t, content, "resources")

	for _, forbidden := range []string{"create", "update", "patch", "delete", "watch"} {
		if containsString(verbs, forbidden) {
			t.Errorf("Kubernetes reader RBAC contains forbidden verb %q", forbidden)
		}
	}
	for _, forbidden := range []string{"secrets", "endpoints"} {
		if containsString(resources, forbidden) {
			t.Errorf("Kubernetes reader RBAC contains forbidden resource %q", forbidden)
		}
	}
	if !containsString(verbs, "get") || !containsString(verbs, "list") {
		t.Errorf("Kubernetes reader RBAC must preserve get/list access: %v", verbs)
	}
	if !regexp.MustCompile(`(?m)resources: \["pods/log"\]\s*\n\s*verbs: \["get"\]`).MatchString(content) {
		t.Error("Kubernetes reader RBAC must preserve get-only access to pods/log")
	}
	if !regexp.MustCompile(`(?s)\{\{- if \.Values\.kubernetesReaderRBAC\.gatewayAPI \}\}.*apiGroups: \["gateway\.networking\.k8s\.io"\].*resources: \["gateways", "httproutes"\].*verbs: \["get", "list"\].*\{\{- end \}\}`).MatchString(content) {
		t.Error("Gateway API read rules must remain gated by kubernetesReaderRBAC.gatewayAPI")
	}
}

func quotedTemplateFieldValues(t *testing.T, content, field string) []string {
	t.Helper()
	fieldPattern := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(field) + `:\s*\[([^]]*)\]`)
	valuePattern := regexp.MustCompile(`"([^"]+)"`)
	var values []string
	for _, fieldMatch := range fieldPattern.FindAllStringSubmatch(content, -1) {
		for _, valueMatch := range valuePattern.FindAllStringSubmatch(fieldMatch[1], -1) {
			values = append(values, valueMatch[1])
		}
	}
	if len(values) == 0 {
		t.Fatalf("no %s entries found in Kubernetes reader RBAC template", field)
	}
	return values
}

func TestKubernetesDocumentationHasUnindentedProseAndHeadings(t *testing.T) {
	document, err := os.ReadFile("../../src/agent/tools/kubernetes.md")
	if err != nil {
		t.Fatal(err)
	}
	inFence := false
	for lineNumber, line := range strings.Split(string(document), "\n") {
		if strings.HasPrefix(line, "```") {
			inFence = !inFence
			continue
		}
		trimmed := strings.TrimLeft(line, " \t")
		indentedHeading := trimmed != line && strings.HasPrefix(trimmed, "#")
		if !inFence && (indentedHeading || strings.HasPrefix(line, "    ") && strings.TrimSpace(line) != "") {
			t.Errorf("line %d is indented outside a code fence: %q", lineNumber+1, line)
		}
	}
	normalized := strings.Join(strings.Fields(string(document)), " ")
	for _, required := range []string{
		"Unset references expand to an empty string.",
		"`$$` names the environment variable `$`",
		"cannot introduce YAML keys or documents",
		"remain part of the scalar string",
	} {
		if !strings.Contains(normalized, required) {
			t.Errorf("Kubernetes documentation is missing environment expansion safety text %q", required)
		}
	}
}
