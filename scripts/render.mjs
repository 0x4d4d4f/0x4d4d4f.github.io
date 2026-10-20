// Renders build/profile-dark.svg and build/profile-light.svg: a neofetch
// in a terminal window, a captured packet on the left, and on the right
// who this is and what the last year of commits looked like.
//
//   GH_TOKEN=… node scripts/render.mjs          (in CI, GITHUB_TOKEN)
//
// The workflow then copies site/ beside them and publishes build/ with Pages.
//
// The numbers come from GitHub's GraphQL API, so a daily run keeps them
// true; everything else is written here. No dependencies.

import { mkdirSync, writeFileSync } from 'node:fs';

const LOGIN = '0x4d4d4f';
const FONT = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

// Primer, GitHub's own palettes.
/** What GitHub counts as a language and a reader would not. */
const NOT_LANGUAGES = new Set(['Makefile', 'Dockerfile', 'HTML', 'CSS', 'Batchfile', 'Procfile']);

const THEMES = {
  dark: {
    canvas: '#0d1117', bar: '#161b22', border: '#30363d', fg: '#e6edf3', muted: '#8b949e',
    key: '#3fb950', user: '#3fb950', accent: '#2f81f7', track: '#21262d',
    eth: '#8b949e', ip: '#58a6ff', tcp: '#d29922', payload: '#3fb950', offset: '#6e7681',
    palette: ['#f85149', '#d29922', '#3fb950', '#2f81f7', '#a371f7', '#39c5cf', '#8b949e', '#e6edf3'],
  },
  light: {
    canvas: '#ffffff', bar: '#f6f8fa', border: '#d0d7de', fg: '#1f2328', muted: '#59636e',
    key: '#1a7f37', user: '#1a7f37', accent: '#0969da', track: '#eaeef2',
    eth: '#59636e', ip: '#0969da', tcp: '#9a6700', payload: '#1a7f37', offset: '#8c959f',
    palette: ['#cf222e', '#9a6700', '#1a7f37', '#0969da', '#8250df', '#1b7c83', '#59636e', '#1f2328'],
  },
};

// --- the packet --------------------------------------------------------------

const checksum = (bytes) => {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) + (bytes[i + 1] ?? 0);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
};
const u16 = (n) => [n >> 8, n & 0xff];
const u32 = (n) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** A server's first words on an SSH connection, as a capture would show them. */
function packet() {
  const payload = [...new TextEncoder().encode('SSH-2.0-0x4d4d4f\r\n')];
  // RFC 5737 documentation addresses: nothing real is named here.
  const src = [192, 0, 2, 22];
  const dst = [198, 51, 100, 7];
  const tcp = [...u16(22), ...u16(51312), ...u32(0x5a1d4c4f), ...u32(0x0d00f00d), 0x50, 0x18, ...u16(502), 0, 0, 0, 0, ...payload];
  const pseudo = [...src, ...dst, 0, 6, ...u16(tcp.length)];
  const tcpSum = checksum([...pseudo, ...tcp]);
  tcp[16] = tcpSum >> 8;
  tcp[17] = tcpSum & 0xff;
  const ip = [0x45, 0, ...u16(20 + tcp.length), 0x4d, 0x4f, 0x40, 0, 64, 6, 0, 0, ...src, ...dst];
  const ipSum = checksum(ip);
  ip[10] = ipSum >> 8;
  ip[11] = ipSum & 0xff;
  const eth = [0x02, 0x00, 0x5e, 0x10, 0x00, 0x07, 0x02, 0x00, 0x5e, 0x10, 0x00, 0x16, 0x08, 0x00];
  return [
    ...eth.map((b) => [b, 'eth']),
    ...ip.map((b) => [b, 'ip']),
    ...tcp.slice(0, 20).map((b) => [b, 'tcp']),
    ...payload.map((b) => [b, 'payload']),
  ];
}

// --- the numbers ---------------------------------------------------------------

async function stats() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is needed to read the numbers');
  const query = `query($login: String!) { user(login: $login) {
    createdAt
    contributionsCollection { totalCommitContributions restrictedContributionsCount
      commitContributionsByRepository(maxRepositories: 50) { contributions { totalCount }
        repository { nameWithOwner isPrivate languages(first: 10, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } } } } } } }`;
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': LOGIN },
    body: JSON.stringify({ query, variables: { login: LOGIN } }),
  });
  const { data, errors } = await response.json();
  if (errors) throw new Error(JSON.stringify(errors));
  const collection = data.user.contributionsCollection;
  // Public repositories only: the same numbers whoever's token reads them,
  // and nothing about private work.
  const repos = collection.commitContributionsByRepository.filter((entry) => !entry.repository.isPrivate);
  // Languages weighted by how much of each repository is in them and how
  // many of the year's commits went there.
  const weights = new Map();
  for (const { contributions, repository } of repos) {
    const total = repository.languages.edges.reduce((sum, edge) => sum + edge.size, 0) || 1;
    for (const { size, node } of repository.languages.edges.filter(({ node }) => !NOT_LANGUAGES.has(node.name))) {
      const entry = weights.get(node.name) ?? { weight: 0, color: node.color };
      entry.weight += (size / total) * contributions.totalCount;
      weights.set(node.name, entry);
    }
  }
  const sum = [...weights.values()].reduce((total, entry) => total + entry.weight, 0) || 1;
  const languages = [...weights.entries()]
    .map(([name, entry]) => ({ name, color: entry.color ?? '#8b949e', share: entry.weight / sum }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 6);
  return {
    commits: repos.reduce((sum, entry) => sum + entry.contributions.totalCount, 0),
    repos: repos.length,
    since: new Date(data.user.createdAt),
    languages,
  };
}

// --- drawing ---------------------------------------------------------------

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(theme, { commits, repos, since, languages }) {
  const t = THEMES[theme];
  const width = 1000;
  const line = 19;
  const out = [];
  const text = (x, y, body, attrs = '') => out.push(`<text x="${x}" y="${y}"${attrs}>${body}</text>`);
  const span = (color, body) => `<tspan fill="${color}">${escape(body)}</tspan>`;

  // Left: the capture.
  const bytes = packet();
  const left = 28;
  let y = 64;
  text(left, y, `${span(t.key, '#')} ${span(t.fg, 'tcpdump -XX -c1 \'tcp src port 22\'')}`);
  y += line + 4;
  for (let at = 0; at < bytes.length; at += 8) {
    const row = bytes.slice(at, at + 8);
    const hex = row.map(([b, layer]) => span(t[layer], b.toString(16).padStart(2, '0'))).join(' ');
    const ascii = row
      .map(([b, layer]) => span(layer === 'payload' ? t.payload : t.offset, b >= 0x21 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
    text(left, y, `${span(t.offset, `0x${at.toString(16).padStart(4, '0')}`)}  ${hex}${'   '.repeat(8 - row.length)}  ${ascii}`);
    y += line;
  }
  y += 6;
  text(left, y, span(t.muted, 'IP 192.0.2.22.22 > 198.51.100.7.51312:'));
  y += line;
  text(left + 16, y, span(t.muted, 'Flags [P.], length 18:\u00a0') + span(t.payload, 'SSH-2.0-0x4d4d4f'));
  y += line + 6;
  text(left, y, [['eth', 'ethernet'], ['ip', 'ipv4'], ['tcp', 'tcp'], ['payload', 'payload']].map(([k, label]) => `${span(t[k], '■')} ${span(t.muted, label)}`).join('  '));
  y += line + 10;
  // The same server, as the scan saw it.
  text(left, y, `${span(t.key, '#')} ${span(t.fg, 'nmap -sV -p22 192.0.2.22')}`);
  y += line + 4;
  text(left, y, span(t.muted, 'PORT'));
  text(left + 80, y, span(t.muted, 'STATE'));
  text(left + 150, y, span(t.muted, 'SERVICE'));
  text(left + 230, y, span(t.muted, 'VERSION'));
  y += line;
  text(left, y, span(t.fg, '22/tcp'));
  text(left + 80, y, span(t.payload, 'open'));
  text(left + 150, y, span(t.fg, 'ssh'));
  text(left + 230, y, span(t.fg, '0x4d4d4f (protocol 2.0)'));
  const leftBottom = y;

  // Right: who, then the year in numbers.
  const right = 470;
  y = 64;
  text(right, y, `${span(t.user, LOGIN)}${span(t.fg, '@')}${span(t.user, 'github')}`, ' font-weight="700"');
  y += 10;
  out.push(`<path d="M${right} ${y}H${width - 32}" stroke="${t.border}"/>`);
  y += line + 2;
  const years = Math.max(0, Math.floor((Date.now() - since.getTime()) / (365.25 * 864e5)));
  const months = Math.floor(((Date.now() - since.getTime()) / (30.44 * 864e5)) % 12);
  const rows = [
    ['Role', 'security analyst'],
    ['Focus', 'network security · protocol analysis'],
    ['Also', 'serverless · Cloudflare Workers · open source'],
    ['OS', 'Linux'],
    ['Langs', 'TypeScript · Go · Rust · C · Python · Shell'],
    ['Tools', 'Nmap · Burp Suite'],
    ['Motto', 'verify, then trust'],
    ['Commits', `${commits.toLocaleString('en-US')} in the last 12 months`],
    ['Repos', `${repos} contributed to this year`],
    ['On GitHub', years ? `${years} year${years > 1 ? 's' : ''}, ${months} month${months === 1 ? '' : 's'}` : `${months} month${months === 1 ? '' : 's'}`],
  ];
  for (const [key, value] of rows) {
    text(right, y, span(t.key, key));
    text(right + 100, y, span(t.fg, value));
    y += line;
  }
  y += 2;
  out.push(`<path d="M${right} ${y}H${width - 32}" stroke="${t.border}"/>`);
  y += line + 2;
  const barX = right + 120;
  const barWidth = 250;
  for (const { name, color, share } of languages) {
    text(right, y, span(t.muted, name));
    out.push(`<rect x="${barX}" y="${y - 11}" width="${barWidth}" height="10" rx="2" fill="${t.track}"/>`);
    out.push(`<rect x="${barX}" y="${y - 11}" width="${Math.max(2, Math.round(barWidth * share))}" height="10" rx="2" fill="${color}"/>`);
    text(barX + barWidth + 12, y, span(t.muted, `${(share * 100).toFixed(1)}%`));
    y += line;
  }
  y += 6;
  t.palette.forEach((color, index) => out.push(`<rect x="${right + index * 30}" y="${y - 6}" width="30" height="16" fill="${color}"/>`));
  const height = Math.max(leftBottom, y + 10) + 24;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" font-size="14" role="img" aria-label="${LOGIN}: security analyst, network security. ${commits} commits in the last 12 months.">
<style>text,tspan{white-space:pre}</style>
<defs><clipPath id="window"><rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6"/></clipPath></defs>
<g clip-path="url(#window)">
<rect width="${width}" height="${height}" fill="${t.canvas}"/>
<rect width="${width}" height="34" fill="${t.bar}"/>
<path d="M0 34.5H${width}" stroke="${t.border}"/>
</g>
<g fill="${t.border}"><circle cx="20" cy="17" r="5"/><circle cx="37" cy="17" r="5"/><circle cx="54" cy="17" r="5"/></g>
<text x="${width / 2}" y="21" text-anchor="middle" font-size="12" fill="${t.muted}">${LOGIN} — neofetch</text>
${out.join('\n')}
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="none" stroke="${t.border}"/>
</svg>
`;
}

const numbers = await stats();
mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
for (const theme of Object.keys(THEMES)) {
  writeFileSync(new URL(`../build/profile-${theme}.svg`, import.meta.url), render(theme, numbers));
}
// The same numbers for the page's neofetch.
writeFileSync(
  new URL('../build/stats.json', import.meta.url),
  JSON.stringify({ ...numbers, since: numbers.since.toISOString(), built: new Date().toISOString() }, null, 2) + '\n',
);
console.log(`${numbers.commits} commits, ${numbers.repos} repositories, ${numbers.languages.map((l) => l.name).join(', ')}`);
