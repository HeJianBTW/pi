import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const severities = ['P0', 'P1', 'P2', 'P3'];
const axes = new Set(['Standards', 'Spec']);
const sides = new Set(['LEFT', 'RIGHT']);
const summaryMarker = '<!-- pi-code-review -->';
const inlineMarkerPrefix = '<!-- pi-code-review-inline:';

function stripJsonFence(value) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function boundedText(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Pi review finding ${name} must be a non-empty string`);
  }
  return value.trim().slice(0, maxLength);
}

export function parseReviewOutput(raw) {
  const parsed = JSON.parse(stripJsonFence(raw));
  if (parsed?.error) throw new Error(`Pi review did not complete: ${String(parsed.error).slice(0, 500)}`);
  if (!Array.isArray(parsed?.findings)) throw new Error('Pi review output must contain a findings array');
  if (parsed.findings.length > 20) throw new Error('Pi review returned more than 20 findings');

  const seen = new Set();
  const seenLocations = new Set();
  return parsed.findings.map((finding, index) => {
    const severity = String(finding?.severity || '').toUpperCase();
    const axis = boundedText(finding?.axis, `#${index + 1} axis`, 20);
    const filePath = boundedText(finding?.path, `#${index + 1} path`, 500);
    const side = String(finding?.side || '').toUpperCase();
    const line = finding?.line;
    if (!severities.includes(severity)) throw new Error(`Pi review finding #${index + 1} has invalid severity`);
    if (!axes.has(axis)) throw new Error(`Pi review finding #${index + 1} has invalid axis`);
    if (!sides.has(side)) throw new Error(`Pi review finding #${index + 1} has invalid side`);
    if (!Number.isInteger(line) || line < 1) throw new Error(`Pi review finding #${index + 1} has invalid line`);
    if (filePath.startsWith('/') || filePath.split('/').includes('..')) {
      throw new Error(`Pi review finding #${index + 1} has an unsafe path`);
    }

    const normalized = {
      severity,
      axis,
      path: filePath,
      line,
      side,
      title: boundedText(finding?.title, `#${index + 1} title`, 160).replace(/\s+/g, ' '),
      body: boundedText(finding?.body, `#${index + 1} body`, 2_000),
      fix: typeof finding?.fix === 'string' ? finding.fix.trim().slice(0, 1_000) : '',
    };
    const key = JSON.stringify(normalized);
    if (seen.has(key)) throw new Error(`Pi review returned duplicate finding #${index + 1}`);
    const locationKey = [axis, filePath, side, line].join('\0');
    if (seenLocations.has(locationKey)) {
      throw new Error(`Pi review returned multiple findings for the same axis and changed line at #${index + 1}`);
    }
    seen.add(key);
    seenLocations.add(locationKey);
    return normalized;
  });
}

export function commentableLines(files) {
  const locations = new Set();
  for (const file of files) {
    if (typeof file.patch !== 'string') continue;
    let inHunk = false;
    let oldLine = 0;
    let newLine = 0;
    for (const patchLine of file.patch.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(patchLine);
      if (hunk) {
        inHunk = true;
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
      } else if (inHunk && patchLine.startsWith('+')) {
        locations.add(`${file.filename}\0RIGHT\0${newLine}`);
        newLine += 1;
      } else if (inHunk && patchLine.startsWith('-')) {
        locations.add(`${file.filename}\0LEFT\0${oldLine}`);
        oldLine += 1;
      } else if (inHunk && patchLine.startsWith(' ')) {
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return locations;
}

function sanitizeComment(value) {
  return value.replaceAll('@', '@\u200b');
}

function inlineBody(finding) {
  const fingerprint = createHash('sha256')
    .update([finding.axis, finding.path, finding.side, finding.line].join('\0'))
    .digest('hex')
    .slice(0, 24);
  const marker = `${inlineMarkerPrefix}${fingerprint} -->`;
  const fix = finding.fix ? `\n\n**Suggested fix:** ${sanitizeComment(finding.fix)}` : '';
  return {
    marker,
    body: `${marker}\n**[${finding.severity}] ${sanitizeComment(finding.title)}** · ${finding.axis}\n\n${sanitizeComment(finding.body)}${fix}`,
  };
}

function sentence(value) {
  const text = sanitizeComment(value).replace(/\s+/g, ' ').trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function locationLink(finding, refs) {
  const label = `${sanitizeComment(finding.path)} (line ${finding.line})`;
  const sha = finding.side === 'LEFT' ? refs?.baseSha : refs?.headSha;
  if (!refs?.owner || !refs?.repo || !sha) return label;
  const serverUrl = (refs.serverUrl || 'https://github.com').replace(/\/$/, '');
  const filePath = finding.path.split('/').map(encodeURIComponent).join('/');
  const url = `${serverUrl}/${encodeURIComponent(refs.owner)}/${encodeURIComponent(refs.repo)}/blob/${encodeURIComponent(sha)}/${filePath}#L${finding.line}`;
  return `[${label}](${url})`;
}

function axisSummary(findings) {
  if (!findings.length) return 'no findings';
  const highest = severities.find((severity) => findings.some((finding) => finding.severity === severity));
  return `${findings.length} finding${findings.length === 1 ? '' : 's'}, highest ${highest}`;
}

export function summaryBody(findings, refs) {
  const sections = ['Standards', 'Spec'].map((axis) => {
    const axisFindings = findings.filter((finding) => finding.axis === axis);
    const content = axisFindings.length
      ? axisFindings
          .map((finding) => {
            const fix = finding.fix ? ` **Suggested fix:** ${sentence(finding.fix)}` : '';
            return `- **${finding.severity} — ${locationLink(finding, refs)}: ${sentence(finding.title)}**\n\n  ${sentence(finding.body)}${fix}`;
          })
          .join('\n\n')
      : 'No actionable findings.';
    return `## ${axis}\n\n${content}`;
  });
  const standards = findings.filter((finding) => finding.axis === 'Standards');
  const spec = findings.filter((finding) => finding.axis === 'Spec');
  return `${summaryMarker}\n${sections.join('\n\n')}\n\n**Summary:** Standards: ${axisSummary(standards)}; Spec: ${axisSummary(spec)}.`;
}

export async function publishPiReview({ github, context, core, reviewPath }) {
  const findings = parseReviewOutput(await readFile(reviewPath, 'utf8'));
  const { owner, repo } = context.repo;
  const pull = context.payload.pull_request;
  const pullNumber = pull.number;
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const validLocations = commentableLines(files);
  for (const finding of findings) {
    if (!validLocations.has(`${finding.path}\0${finding.side}\0${finding.line}`)) {
      throw new Error(`Pi review finding is not on a changed line: ${finding.path}:${finding.line} (${finding.side})`);
    }
  }

  const previousInline = await github.paginate(github.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const newComments = [];
  const retainedCommentIds = new Set();
  for (const finding of findings) {
    const formatted = inlineBody(finding);
    const previous = previousInline.find(
      (comment) =>
        !retainedCommentIds.has(comment.id) &&
        comment.user?.type === 'Bot' &&
        comment.body?.includes(formatted.marker),
    );
    if (previous) {
      retainedCommentIds.add(previous.id);
      if (previous.body !== formatted.body) {
        await github.rest.pulls.updateReviewComment({ owner, repo, comment_id: previous.id, body: formatted.body });
      }
    } else {
      newComments.push({
        path: finding.path,
        line: finding.line,
        side: finding.side,
        body: formatted.body,
      });
    }
  }
  if (newComments.length) {
    await github.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: pull.head.sha,
      event: 'COMMENT',
      body: 'Pi code review inline findings.',
      comments: newComments,
    });
  }
  for (const comment of previousInline) {
    if (
      comment.user?.type === 'Bot' &&
      comment.body?.includes(inlineMarkerPrefix) &&
      !retainedCommentIds.has(comment.id)
    ) {
      await github.rest.pulls.deleteReviewComment({ owner, repo, comment_id: comment.id });
    }
  }

  const body = summaryBody(findings, {
    owner,
    repo,
    headSha: pull.head.sha,
    baseSha: pull.base?.sha,
    serverUrl: process.env.GITHUB_SERVER_URL,
  });
  const previousSummaries = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const previousSummary = previousSummaries.find(
    (comment) => comment.user?.type === 'Bot' && comment.body?.includes(summaryMarker),
  );
  if (previousSummary) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: previousSummary.id, body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body });
  }

  const blocking = findings.filter((finding) => finding.severity === 'P0' || finding.severity === 'P1');
  if (blocking.length) core.setFailed(`Pi review found ${blocking.length} blocking P0/P1 finding(s)`);
  return { findings, blocking };
}
