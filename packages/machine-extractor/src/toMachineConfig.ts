import {
  Actions,
  MachineConfig,
  StateNodeConfig,
  TransitionConfigOrTarget,
} from 'xstate';
import { ActionNode, MaybeArrayOfActions } from './actions';
import { CondNode } from './conds';
import {
  extractAssignAction,
  extractLogAction,
  extractRaiseAction,
  extractSendToAction,
  extractStopAction,
  getActionCreatorName,
} from './extractAction';
import { TMachineCallExpression } from './machineCallExpression';
import { StateNodeReturn } from './stateNode';
import { MaybeTransitionArray } from './transitions';
import { GetParserResult } from './utils';

export interface ToMachineConfigOptions {
  /**
   * Whether to attempt builtin actions and inline expressions extraction.
   *
   * @default false
   */
  serializeInlineActions?: boolean;

  /**
   * Whether or not to hash inline implementations, which
   * allow for parsing inline implementations as code.
   *
   * @default false
   */
  hashInlineImplementations?: boolean;

  /**
   * Whether to use a static string in place of inline implementations.
   * This makes it easier to compare two different configs with `deepEqual`
   *
   * @default false
   */
  anonymizeInlineImplementations?: boolean;
  /**
   * Original source code text
   */
  fileContent: string;
}

const parseStateNode = (
  astResult: StateNodeReturn,
  opts: ToMachineConfigOptions | undefined,
): StateNodeConfig<any, any, any> => {
  const config: MachineConfig<any, any, any> = {};

  if (astResult?.id) {
    config.id = astResult.id.value;
  }

  if (astResult?.initial) {
    config.initial = astResult.initial.value;
  }

  if (astResult?.type) {
    config.type = astResult.type.value as any;
  }

  if (astResult.entry) {
    config.entry = getActionConfig(astResult.entry, opts);
  }
  if (astResult.onEntry) {
    config.onEntry = getActionConfig(astResult.onEntry, opts);
  }
  if (astResult.exit) {
    config.exit = getActionConfig(astResult.exit, opts);
  }
  if (astResult.onExit) {
    config.onExit = getActionConfig(astResult.onExit, opts);
  }

  if (astResult.tags) {
    const tags = astResult.tags.map((tag) => tag.value);

    if (tags.length === 1) {
      config.tags = tags[0];
    } else {
      config.tags = tags;
    }
  }

  if (astResult.on) {
    config.on = {};

    astResult.on.properties.forEach((onProperty) => {
      (config.on as any)[onProperty.key] = getTransitions(
        onProperty.result,
        opts,
      );
    });
  }

  if (astResult.after) {
    config.after = {};

    astResult.after.properties.forEach((afterProperty) => {
      (config.after as any)[afterProperty.key] = getTransitions(
        afterProperty.result,
        opts,
      );
    });
  }

  if (astResult.history) {
    config.history = astResult.history.value;
  }

  if (astResult.states) {
    const states: typeof config.states = {};

    astResult.states.properties.forEach((state) => {
      states[state.key] = parseStateNode(state.result, opts);
    });

    config.states = states;
  }

  if (astResult.always) {
    config.always = getTransitions(astResult.always, opts);
  }

  if (astResult.meta?.description) {
    config.meta = {
      description: astResult.meta.description.value,
    };
  }

  if (astResult.onDone) {
    config.onDone = getTransitions(astResult.onDone, opts) as any[];
  }

  if (astResult.description) {
    config.description = astResult.description.value;
  }

  if (astResult.invoke) {
    const invokes: typeof config.invoke = [];

    astResult.invoke.forEach((invoke) => {
      if (!invoke.src) {
        return;
      }
      let src: string | undefined;

      switch (true) {
        case invoke.src.declarationType === 'named':
          src = invoke.src.value;
          break;
        case opts?.anonymizeInlineImplementations:
          src = 'anonymous';
        case opts?.hashInlineImplementations:
          src = invoke.src.inlineDeclarationId;
      }

      const toPush: (typeof invokes)[number] = {
        src: src || (() => () => {}),
      };

      if (invoke.id) {
        toPush.id = invoke.id.value;
      }

      if (invoke.autoForward) {
        toPush.autoForward = invoke.autoForward.value;
      }

      if (invoke.forward) {
        toPush.forward = invoke.forward.value;
      }

      if (invoke.onDone) {
        toPush.onDone = getTransitions(invoke.onDone, opts) as any[];
      }

      if (invoke.onError) {
        toPush.onError = getTransitions(invoke.onError, opts) as any[];
      }

      invokes.push(toPush);
    });

    if (invokes.length === 1) {
      config.invoke = invokes[0];
    } else {
      config.invoke = invokes;
    }
  }

  return config;
};

export const toMachineConfig = (
  result: TMachineCallExpression,
  opts?: ToMachineConfigOptions,
): MachineConfig<any, any, any> | undefined => {
  if (!result?.definition) return undefined;
  return parseStateNode(result?.definition, opts);
};

export const getActionConfig = (
  astActions: GetParserResult<typeof MaybeArrayOfActions>,
  opts: ToMachineConfigOptions | undefined,
): Actions<any, any> => {
  const actions: Actions<any, any> = [];

  // Todo: these actions should be extracted in `actions.ts`
  astActions?.forEach((action) => {
    switch (true) {
      case action.declarationType === 'named':
        actions.push(action.name);
        return;
      case opts?.anonymizeInlineImplementations:
        actions.push({
          type: 'anonymous',
        });
        return;
      case opts?.hashInlineImplementations:
        actions.push({
          type: action.inlineDeclarationId,
        });
        return;
      case !!action.chooseConditions:
        actions.push({
          type: 'xstate.choose',
          conds: action.chooseConditions!.map((condition) => {
            const cond = getCondition(condition.conditionNode, opts);
            return {
              ...(cond && { cond }),
              actions: getActionConfig(condition.actionNodes, opts),
            };
          }),
        });
        return;
      case opts?.serializeInlineActions: {
        switch (getActionCreatorName(action)) {
          // Todo: think about error reporting and how to handle invalid actions such as raise(2)
          case 'assign':
            actions.push({
              type: 'xstate.assign',
              assignment: extractAssignAction(action, opts!.fileContent),
            });
            return;
          case 'raise':
            actions.push({
              type: 'xstate.raise',
              event: extractRaiseAction(action, opts!.fileContent),
            });
            return;
          case 'log':
            actions.push({
              type: 'xstate.log',
              expr: extractLogAction(action, opts!.fileContent),
            });
            return;
          case 'sendTo':
            actions.push({
              type: 'xstate.sendTo',
              ...extractSendToAction(action, opts!.fileContent),
            });
            return;
          case 'stop':
            actions.push({
              type: 'xstate.stop',
              id: extractStopAction(action, opts!.fileContent),
            });
            return;
          default:
            actions.push({
              type: 'xstate.custom',
              value: {
                type: 'expression',
                value: opts!.fileContent.slice(
                  action.node.start!,
                  action.node.end!,
                ),
              },
            });
            return;
        }
      }
    }
  });

  if (actions.length === 1) {
    return actions[0];
  }

  return actions;
};

const getCondition = (
  condNode: CondNode | undefined,
  opts: ToMachineConfigOptions | undefined,
) => {
  if (!condNode) {
    return;
  }
  switch (true) {
    case condNode.declarationType === 'named':
      return condNode.name;
    case opts?.anonymizeInlineImplementations:
      return 'anonymous';
    case opts?.hashInlineImplementations:
      return condNode.inlineDeclarationId;
  }
};

export const getTransitions = (
  astTransitions: GetParserResult<typeof MaybeTransitionArray>,
  opts: ToMachineConfigOptions | undefined,
): TransitionConfigOrTarget<any, any> => {
  const transitions: TransitionConfigOrTarget<any, any> = [];

  astTransitions?.forEach((transition) => {
    const toPush: TransitionConfigOrTarget<any, any> = {};
    if (transition?.target && transition?.target?.length > 0) {
      if (transition.target.length === 1) {
        toPush.target = transition?.target[0].value;
      } else {
        toPush.target = transition?.target.map((target) => target.value);
      }
    }
    const cond = getCondition(transition?.cond, opts);
    if (cond) {
      toPush.cond = cond;
    }
    if (transition?.actions) {
      toPush.actions = getActionConfig(transition.actions, opts);
    }
    if (transition?.description) {
      toPush.description = transition?.description.value;
    }

    transitions.push(toPush);
  });

  if (transitions.length === 1) {
    return transitions[0];
  }

  return transitions;
};
