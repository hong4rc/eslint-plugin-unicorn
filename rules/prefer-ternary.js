'use strict';
const {isParenthesized} = require('eslint-utils');
const {flatten} = require('lodash');
const FixTracker = require('eslint/lib/rules/utils/fix-tracker');
const getDocumentationUrl = require('./utils/get-documentation-url');
const avoidCapture = require('./utils/avoid-capture');

const messageId = 'prefer-ternary';

const selector = [
	'IfStatement',
	':not(IfStatement > IfStatement.alternate)',
	'[test.type!="ConditionalExpression"]',
	'[consequent]',
	'[alternate]'
].join('');

const isTernary = node => node && node.type === 'ConditionalExpression';

function getNodeBody(node) {
	/* istanbul ignore next */
	if (!node) {
		return;
	}

	if (node.type === 'ExpressionStatement') {
		return getNodeBody(node.expression);
	}

	if (node.type === 'BlockStatement') {
		const body = node.body.filter(({type}) => type !== 'EmptyStatement');
		if (body.length === 1) {
			return getNodeBody(body[0]);
		}
	}

	return node;
}

function isSameAssignmentLeft(node1, node2) {
	// [TODO]: Allow more types of left
	return node1.type === node2.type && node1.type === 'Identifier' && node1.name === node2.name;
}

const getIndentString = (node, sourceCode) => {
	const {line, column} = sourceCode.getLocFromIndex(node.range[0]);
	const lines = sourceCode.getLines();
	const before = lines[line - 1].slice(0, column);

	return before.match(/\s*$/)[0];
};

const getScopes = scope => [
	scope,
	...flatten(scope.childScopes.map(scope => getScopes(scope)))
];

const create = context => {
	const sourceCode = context.getSourceCode();
	const scopeToNamesGeneratedByFixer = new WeakMap();
	const isSafeName = (name, scopes) => scopes.every(scope => {
		const generatedNames = scopeToNamesGeneratedByFixer.get(scope);
		return !generatedNames || !generatedNames.has(name);
	});

	const getParenthesizedText = node => {
		const text = sourceCode.getText(node);
		return (
			isParenthesized(node, sourceCode) ||
			node.type === 'AwaitExpression' ||
			// Lower precedence, see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Operator_Precedence#Table
			node.type === 'AssignmentExpression' ||
			node.type === 'YieldExpression' ||
			node.type === 'SequenceExpression'
		) ?
			`(${text})` : text;
	};

	function merge(options, mergeOptions) {
		const {
			before = '',
			after = ';',
			consequent,
			alternate,
			node
		} = options;

		const {
			checkThrowStatement,
			returnFalseIfNotMergeable
		} = {
			checkThrowStatement: false,
			returnFalseIfNotMergeable: false,
			...mergeOptions
		};

		if (!consequent || !alternate || consequent.type !== alternate.type) {
			return returnFalseIfNotMergeable ? false : options;
		}

		const {type} = consequent;

		if (
			type === 'ReturnStatement' &&
			!isTernary(consequent.argument) &&
			!isTernary(alternate.argument)
		) {
			return merge({
				before: `${before}return `,
				after,
				consequent: consequent.argument === null ? 'undefined' : consequent.argument,
				alternate: alternate.argument === null ? 'undefined' : alternate.argument,
				node
			});
		}

		if (
			type === 'YieldExpression' &&
			consequent.delegate === alternate.delegate &&
			!isTernary(consequent.argument) &&
			!isTernary(alternate.argument)
		) {
			return merge({
				before: `${before}yield${consequent.delegate ? '*' : ''} (`,
				after: `)${after}`,
				consequent: consequent.argument === null ? 'undefined' : consequent.argument,
				alternate: alternate.argument === null ? 'undefined' : alternate.argument,
				node
			});
		}

		if (
			type === 'AwaitExpression' &&
			!isTernary(consequent.argument) &&
			!isTernary(alternate.argument)
		) {
			return merge({
				before: `${before}await (`,
				after: `)${after}`,
				consequent: consequent.argument,
				alternate: alternate.argument,
				node
			});
		}

		if (
			checkThrowStatement &&
			type === 'ThrowStatement' &&
			!isTernary(consequent.argument) &&
			!isTernary(alternate.argument)
		) {
			// `ThrowStatement` don't check nested

			// If `IfStatement` is not a `BlockStatement`, need add `{}`
			const {parent} = node;
			const needBraces = parent && parent.type !== 'BlockStatement';
			return {
				type,
				before: `${before}${needBraces ? '{\n{{INDENT_STRING}}' : ''}const {{ERROR_NAME}} = `,
				after: `;\n{{INDENT_STRING}}throw {{ERROR_NAME}};${needBraces ? '\n}' : ''}`,
				consequent: consequent.argument,
				alternate: alternate.argument
			};
		}

		if (
			type === 'AssignmentExpression' &&
			isSameAssignmentLeft(consequent.left, alternate.left) &&
			consequent.operator === alternate.operator &&
			!isTernary(consequent.left) &&
			!isTernary(alternate.left) &&
			!isTernary(consequent.right) &&
			!isTernary(alternate.right)
		) {
			return merge({
				before: `${before}${sourceCode.getText(consequent.left)} ${consequent.operator} `,
				after,
				consequent: consequent.right,
				alternate: alternate.right,
				node
			});
		}

		return returnFalseIfNotMergeable ? false : options;
	}

	return {
		[selector](node) {
			const consequent = getNodeBody(node.consequent);
			const alternate = getNodeBody(node.alternate);

			const result = merge({node, consequent, alternate}, {
				checkThrowStatement: true,
				returnFalseIfNotMergeable: true
			});

			if (!result) {
				return;
			}

			const scope = context.getScope();
			const sourceCode = context.getSourceCode();

			context.report({
				node,
				messageId,
				fix: fixer => {
					const testText = getParenthesizedText(node.test);
					const consequentText = typeof result.consequent === 'string' ?
						result.consequent :
						getParenthesizedText(result.consequent);
					const alternateText = typeof result.alternate === 'string' ?
						result.alternate :
						getParenthesizedText(result.alternate);

					let {type, before, after} = result;

					let generateNewVariables = false;
					if (type === 'ThrowStatement') {
						const scopes = getScopes(scope);
						const errorName = avoidCapture('error', scopes, context.parserOptions.ecmaVersion, isSafeName);

						for (const scope of scopes) {
							if (!scopeToNamesGeneratedByFixer.has(scope)) {
								scopeToNamesGeneratedByFixer.set(scope, new Set());
							}

							const generatedNames = scopeToNamesGeneratedByFixer.get(scope);
							generatedNames.add(errorName);
						}

						const indentString = getIndentString(node, sourceCode);

						after = after
							.replace('{{INDENT_STRING}}', indentString)
							.replace('{{ERROR_NAME}}', errorName);
						before = before
							.replace('{{INDENT_STRING}}', indentString)
							.replace('{{ERROR_NAME}}', errorName);
						generateNewVariables = true;
					}

					const fixed = `${before}${testText} ? ${consequentText} : ${alternateText}${after}`;
					if (!generateNewVariables) {
						return fixer.replaceText(node, fixed);
					}

					return new FixTracker(fixer, sourceCode)
						.retainRange(sourceCode.ast.range)
						.replaceTextRange(node.range, fixed);
				}
			});
		}
	};
};

module.exports = {
	create,
	meta: {
		type: 'suggestion',
		docs: {
			url: getDocumentationUrl(__filename)
		},
		messages: {
			[messageId]: 'This `if` statement can be replaced by a ternary expression.'
		},
		fixable: 'code'
	}
};
