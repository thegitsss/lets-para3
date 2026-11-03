// Static route inventory only: expand finite literal provider loops without
// treating an arbitrary runtime template as a mounted wildcard route.
const { parse } = require('@babel/parser');
function names(pattern) {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern.name];
  if (pattern.type === 'RestElement') return names(pattern.argument);
  if (pattern.type === 'AssignmentPattern') return names(pattern.left);
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(names);
  if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap(item => names(item.value || item.argument));
  return [];
}
function literalRoutePaths(source, routerName = 'router') {
  const paths = new Set();
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
  function visit(node, incoming = new Map()) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ForOfStatement') {
      const id = node.left.type === 'VariableDeclaration' && node.left.declarations.length === 1 ? node.left.declarations[0].id : node.left;
      const binding = id?.type === 'Identifier' ? id.name : null;
      const finite = binding && node.right.type === 'ArrayExpression' && node.right.elements.every(value => value?.type === 'StringLiteral');
      if (finite) {
        for (const value of node.right.elements) visit(node.body, new Map([...incoming, [binding, value.value]]));
      } else {
        const environment = new Map(incoming);
        for (const name of names(id)) environment.delete(name);
        visit(node.body, environment);
      }
      return;
    }
    const environment = new Map(incoming);
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      for (const name of [...names(node.id), ...node.params.flatMap(names)]) environment.delete(name);
    }
    if (node.type === 'BlockStatement') {
      for (const statement of node.body) if (statement.type === 'VariableDeclaration') {
        for (const declaration of statement.declarations) for (const name of names(declaration.id)) environment.delete(name);
      }
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && node.callee.object.name === routerName) {
      const method = node.callee.computed ? node.callee.property.value : node.callee.property.name;
      const route = node.arguments[0];
      if (methods.has(method)) {
        if (route?.type === 'StringLiteral') paths.add(route.value);
        else if (route?.type === 'TemplateLiteral' && route.expressions.every(part => part.type === 'Identifier' && environment.has(part.name))) {
          paths.add(route.quasis.map((part, i) => part.value.cooked + (i < route.expressions.length ? environment.get(route.expressions[i].name) : '')).join(''));
        }
      }
    }
    for (const [key, value] of Object.entries(node)) if (!['loc', 'extra', 'comments'].includes(key)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, environment));
      else if (value && typeof value === 'object') visit(value, environment);
    }
  }
  visit(parse(source, { sourceType: 'unambiguous' }).program);
  return [...paths];
}
module.exports = { literalRoutePaths };
