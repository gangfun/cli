/**
 * `gang buy --help`, `gang create -h`: whether argv (after `gang`) asks a command for its help. The CLI answers with the
 * help text, and the MCP server's gang_cli points to gang_help. A --help / -h right after a flag whose value may be free
 * text is that value, not a request for help. No imports: the MCP server loads this too.
 */
const TEXT_FLAGS = new Set(['--note', '--description', '--name', '--symbol'])

export const wantsHelp = (argv) => argv.some((a, i) => i > 0 && (a === '--help' || a === '-h') && !TEXT_FLAGS.has(argv[i - 1]))
