export interface ChatEntityReferenceIpcRow {
  id: string;
  entity_type: string;
  display_label: string;
  locator: string;
  deep_link_params: string | null;
  data: string | null;
  source: string;
  status: string;
  workspace_scope: string | null;
  workspace_root_path: string | null;
  created_at: number;
  updated_at: number;
}
