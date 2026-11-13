const ts = require('typescript');
const { inspectUserMessages } = require('../../scripts/lib/user-message-rule.cjs');

module.exports = {
  rules: {
    'approved-text': {
      meta: { type: 'problem', schema: [], messages: { boundary: '{{fix}}' } },
      create(context) {
        return {
          Program() {
            const filename = require('node:path').relative(require('node:path').resolve(__dirname, '../..'), context.getFilename()).replaceAll('\\', '/');
            for (const finding of inspectUserMessages(context.getSourceCode().text, filename, ts)) {
              context.report({
                loc: { line: finding.line, column: finding.column - 1 },
                messageId: 'boundary',
                data: { fix: finding.fix },
              });
            }
          },
        };
      },
    },
  },
};
