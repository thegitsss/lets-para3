const { parse } = require("@babel/parser");
// Compare program meaning while ignoring printer choices. Tagged-template raw
// text remains significant; only ordinary template spelling is normalized.
function semantic(node,parent) {
 if (!node || typeof node!=="object") return node;
 if (Array.isArray(node)) { node.forEach(n=>semantic(n,parent)); return node; }
 if (node.type==="TemplateLiteral" && parent?.type!=="TaggedTemplateExpression") for(const quasi of node.quasis) delete quasi.value.raw;
 if (node.type==="ObjectProperty") delete node.shorthand;
 if (node.type==="ArrowFunctionExpression" && node.body.type==="BlockStatement" && !node.body.directives?.length && node.body.body.length===1 && node.body.body[0].type==="ReturnStatement" && node.body.body[0].argument) node.body=node.body.body[0].argument;
 if (["ObjectProperty","ObjectMethod","ClassMethod","ClassProperty"].includes(node.type) && !node.computed && ["Identifier","StringLiteral","NumericLiteral"].includes(node.key?.type)) node.key={type:"StaticPropertyKey",value:String(node.key.name??node.key.value)};
 for(const value of Object.values(node))if(value&&typeof value==="object")semantic(value,node);
 return node;
}
const omit=new Set(["start","end","loc","extra","comments","leadingComments","trailingComments","innerComments","errors","tokens"]);
function clean(v){if(Array.isArray(v))return v.map(clean);if(v&&typeof v==="object")return Object.fromEntries(Object.keys(v).sort().filter(k=>!omit.has(k)).map(k=>[k,clean(v[k])]));return v;}

module.exports = source => clean(semantic(parse(source, { sourceType: "unambiguous" })));
