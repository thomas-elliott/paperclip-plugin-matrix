import { KeyValueList, Spinner, StatusBadge, usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import type { ConnectionStatus } from "../worker.js";

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<ConnectionStatus>("connection", { companyId: context.companyId });

  if (loading) return <Spinner size="sm" label="Checking Matrix connection" />;
  if (error) return <StatusBadge status="error" label={`Could not check Matrix: ${error.message}`} />;
  if (!data?.connected) return <StatusBadge status="error" label={data?.reason ?? "Not connected"} />;

  return (
    <KeyValueList
      pairs={[
        { label: "Status", value: <StatusBadge status="ok" label="Connected" /> },
        { label: "Signed in as", value: data.userId },
        { label: "Reading rooms", value: data.sync?.running ? "Yes" : (data.sync?.lastError ?? "No") },
      ]}
    />
  );
}
