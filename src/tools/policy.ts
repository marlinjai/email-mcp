// The operator configures this outside the MCP protocol. Tool arguments can
// never enable capabilities. Explicit configuration is an exact allowlist.
const READ_TOOLS = new Set([
  'email_list_accounts', 'email_test_account', 'email_list_folders',
  'email_search', 'email_get', 'email_get_thread', 'email_get_attachment',
  'email_draft_list', 'email_get_labels', 'email_get_categories',
  'email_list_block_rules', 'email_list_forward_rules',
]);

/** Use the default read-tool set unless an exact process allowlist is supplied; an empty list denies all tools. */
export function isToolEnabled(name: string): boolean {
  const configured = process.env.EMAIL_MCP_ALLOWED_TOOLS;
  if (configured === undefined) return READ_TOOLS.has(name);
  return configured.split(',').some((value) => value.trim() === name);
}
