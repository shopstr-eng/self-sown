// Match SWC's top-level Jest mock hoisting without Babel's stricter mock-factory
// variable-name policy (the repository's tests normally run through SWC).
module.exports = ({ types }) => ({
  visitor: {
    StringLiteral(literal) {
      if (!literal.node.value.startsWith("@/")) return;
      const parent = literal.parentPath;
      const isModuleSource = (parent.isImportDeclaration() || parent.isExportNamedDeclaration() || parent.isExportAllDeclaration()) &&
        parent.node.source === literal.node;
      const callee = parent.isCallExpression() && parent.node.callee;
      const isModuleCall = callee && parent.node.arguments[0] === literal.node &&
        ((callee.type === "Identifier" && callee.name === "require") ||
         callee.type === "Import" ||
         (callee.type === "MemberExpression" && callee.object.type === "Identifier" &&
          ["jest", "require"].includes(callee.object.name)));
      if (isModuleSource || isModuleCall) {
        literal.node.value = require("node:path").join(process.cwd(), literal.node.value.slice(2));
      }
    },
    Program(program) {
      // Preserve native ESM createRequire(import.meta.url) semantics when the
      // test-only Babel transformer emits CommonJS instead of SWC's output.
      if (program.scope.hasOwnBinding("require")) {
        program.scope.rename("require", "isolatedModuleRequire");
      }
    },
    MemberExpression(member) {
      const object = member.node.object;
      if (object.type === "MetaProperty" && object.meta.name === "import" &&
          member.node.property.type === "Identifier" && member.node.property.name === "url") {
        member.replaceWith(types.memberExpression(
          types.callExpression(
            types.memberExpression(
              types.callExpression(types.identifier("require"), [types.stringLiteral("node:url")]),
              types.identifier("pathToFileURL")
            ), [types.identifier("__filename")]
          ), types.identifier("href")
        ));
      }
    },
    ExpressionStatement(statement) {
      if (!statement.parentPath.isProgram()) return;
      const expression = statement.node.expression;
      const callee = expression.type === "CallExpression" && expression.callee;
      if (callee && callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" && callee.object.name === "jest" &&
          callee.property.type === "Identifier" &&
          ["mock", "unmock", "enableAutomock", "disableAutomock"].includes(callee.property.name)) {
        statement.node._blockHoist = 4;
      }
    },
  },
});
