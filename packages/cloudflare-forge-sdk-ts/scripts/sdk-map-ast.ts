import ts from 'typescript';

export function findRequestParameter(member: ts.MethodDeclaration): ts.ParameterDeclaration | undefined {
  return member.parameters.find((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'request');
}
