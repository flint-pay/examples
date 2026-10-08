// Browser subprocesses need OS configuration, never the worker's server authority.
export function browserEnvironment(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const names = [
    'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ',
    'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH',
  ];
  return Object.fromEntries(names.flatMap(name => parent[name] === undefined ? [] : [[name, parent[name]!]]));
}
