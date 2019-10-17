import debugModule from "debug";
const debug = debugModule("debugger:evm:selectors"); // eslint-disable-line no-unused-vars

import { createSelectorTree, createLeaf } from "reselect-tree";
import BN from "bn.js";

import trace from "lib/trace/selectors";

import { Utils as CodecUtils } from "@truffle/codec";
import {
  isCallMnemonic,
  isCreateMnemonic,
  isShortCallMnemonic,
  isDelegateCallMnemonicBroad,
  isDelegateCallMnemonicStrict,
  isStaticCallMnemonic,
  isNormalHaltingMnemonic
} from "lib/helpers";

/**
 * create EVM-level selectors for a given trace step selector
 * may specify additional selectors to include
 */
function createStepSelectors(step, state = null) {
  let base = {
    /**
     * .trace
     *
     * trace step info related to operation
     */
    trace: createLeaf([step], step => {
      if (!step) {
        return null;
      }
      let { gasCost, op, pc } = step;
      return { gasCost, op, pc };
    }),

    /**
     * .programCounter
     */
    programCounter: createLeaf(["./trace"], step => (step ? step.pc : null)),

    /**
     * .isJump
     */
    isJump: createLeaf(
      ["./trace"],
      step => step.op != "JUMPDEST" && step.op.indexOf("JUMP") == 0
    ),

    /**
     * .isCall
     *
     * whether the opcode will switch to another calling context
     */
    isCall: createLeaf(["./trace"], step => isCallMnemonic(step.op)),

    /**
     * .isShortCall
     *
     * for calls that only take 6 arguments instead of 7
     */
    isShortCall: createLeaf(["./trace"], step => isShortCallMnemonic(step.op)),

    /**
     * .isDelegateCallBroad
     *
     * for calls that delegate storage
     */
    isDelegateCallBroad: createLeaf(["./trace"], step =>
      isDelegateCallMnemonicBroad(step.op)
    ),

    /**
     * .isDelegateCallStrict
     *
     * for calls that additionally delegate sender and value
     */
    isDelegateCallStrict: createLeaf(["./trace"], step =>
      isDelegateCallMnemonicStrict(step.op)
    ),

    /**
     * .isStaticCall
     */
    isStaticCall: createLeaf(["./trace"], step =>
      isStaticCallMnemonic(step.op)
    ),

    /**
     * .isCreate
     */
    isCreate: createLeaf(["./trace"], step => isCreateMnemonic(step.op)),

    /**
     * .isHalting
     *
     * whether the instruction halts or returns from a calling context
     * NOTE: this covers only ordinary halts, not exceptional halts;
     * but it doesn't check the return status, so any normal halting
     * instruction will qualify here
     */
    isHalting: createLeaf(["./trace"], step =>
      isNormalHaltingMnemonic(step.op)
    ),

    /*
     * .isStore
     */
    isStore: createLeaf(["./trace"], step => step.op == "SSTORE"),

    /*
     * .isLoad
     */
    isLoad: createLeaf(["./trace"], step => step.op == "SLOAD"),

    /*
     * .touchesStorage
     *
     * whether the instruction involves storage
     */
    touchesStorage: createLeaf(
      ["./isStore", "isLoad"],
      (stores, loads) => stores || loads
    )
  };

  if (state) {
    const isRelative = path =>
      typeof path == "string" &&
      (path.startsWith("./") || path.startsWith("../"));

    if (isRelative(state)) {
      state = `../${state}`;
    }

    Object.assign(base, {
      /**
       * .callAddress
       *
       * address transferred to by call operation
       */
      callAddress: createLeaf(
        ["./isCall", state],

        (isCall, { stack }) => {
          if (!isCall) {
            return null;
          }

          let address = stack[stack.length - 2];
          return CodecUtils.Conversion.toAddress(address);
        }
      ),

      /**
       * .createBinary
       *
       * binary code to execute via create operation
       */
      createBinary: createLeaf(
        ["./isCreate", state],

        (isCreate, { stack, memory }) => {
          if (!isCreate) {
            return null;
          }

          // Get the code that's going to be created from memory.
          // Note we multiply by 2 because these offsets are in bytes.
          const offset = parseInt(stack[stack.length - 2], 16) * 2;
          const length = parseInt(stack[stack.length - 3], 16) * 2;

          return "0x" + memory.join("").substring(offset, offset + length);
        }
      ),

      /**
       * .callData
       *
       * data passed to EVM call
       */
      callData: createLeaf(
        ["./isCall", "./isShortCall", state],
        (isCall, short, { stack, memory }) => {
          if (!isCall) {
            return null;
          }

          //if it's 6-argument call, the data start and offset will be one spot
          //higher in the stack than they would be for a 7-argument call, so
          //let's introduce an offset to handle this
          let argOffset = short ? 1 : 0;

          // Get the data from memory.
          // Note we multiply by 2 because these offsets are in bytes.
          const offset = parseInt(stack[stack.length - 4 + argOffset], 16) * 2;
          const length = parseInt(stack[stack.length - 5 + argOffset], 16) * 2;

          return "0x" + memory.join("").substring(offset, offset + length);
        }
      ),

      /**
       * .callValue
       *
       * value for the call (not create); returns null for DELEGATECALL
       */
      callValue: createLeaf(
        ["./isCall", "./isDelegateCallStrict", "./isStaticCall", state],
        (calls, delegates, isStatic, { stack }) => {
          if (!calls || delegates) {
            return null;
          }

          if (isStatic) {
            return new BN(0);
          }

          //otherwise, for CALL and CALLCODE, it's the 3rd argument
          let value = stack[stack.length - 3];
          return CodecUtils.Conversion.toBN(value);
        }
      ),

      /**
       * .createValue
       *
       * value for the create
       */
      createValue: createLeaf(["./isCreate", state], (isCreate, { stack }) => {
        if (!isCreate) {
          return null;
        }

        //creates have the value as the first argument
        let value = stack[stack.length - 1];
        return CodecUtils.Conversion.toBN(value);
      }),

      /**
       * .storageAffected
       *
       * storage slot being stored to or loaded from
       * we do NOT prepend "0x"
       */
      storageAffected: createLeaf(
        ["./touchesStorage", state],

        (touchesStorage, { stack }) => {
          if (!touchesStorage) {
            return null;
          }

          return stack[stack.length - 1];
        }
      ),

      /*
       * .returnValue
       *
       * for a RETURN instruction, the value returned
       * we DO prepend "0x"
       * (will also return "0x" for STOP or SELFDESTRUCT but
       * null otherwise)
       */
      returnValue: createLeaf(
        ["./trace", "./isHalting", state],

        (step, isHalting, { stack, memory }) => {
          if (!isHalting) {
            return null;
          }
          if (step.op !== "RETURN") {
            //STOP and SELFDESTRUCT return empty value
            return "0x";
          }
          // Get the data from memory.
          // Note we multiply by 2 because these offsets are in bytes.
          const offset = parseInt(stack[stack.length - 1], 16) * 2;
          const length = parseInt(stack[stack.length - 2], 16) * 2;

          return "0x" + memory.join("").substring(offset, offset + length);
        }
      )
    });
  }

  return base;
}

const evm = createSelectorTree({
  /**
   * evm.state
   */
  state: state => state.evm,

  /**
   * evm.info
   */
  info: {
    /**
     * evm.info.contexts
     */
    contexts: createLeaf(["/state"], state => state.info.contexts.byContext),

    /**
     * evm.info.binaries
     */
    binaries: {
      /**
       * evm.info.binaries.search
       *
       * returns function (binary) => context (returns the *ID* of the context)
       * (returns null on no match)
       */
      search: createLeaf(["/info/contexts"], contexts => binary =>
        CodecUtils.ContextUtils.findDebuggerContext(contexts, binary)
      )
    }
  },

  /**
   * evm.transaction
   */
  transaction: {
    /*
     * evm.transaction.globals
     */
    globals: {
      /*
       * evm.transaction.globals.tx
       */
      tx: createLeaf(["/state"], state => state.transaction.globals.tx),
      /*
       * evm.transaction.globals.block
       */
      block: createLeaf(["/state"], state => state.transaction.globals.block)
    },

    /*
     * evm.transaction.status
     */
    status: createLeaf(["/state"], state => state.transaction.status),

    /*
     * evm.transaction.initialCall
     */
    initialCall: createLeaf(["/state"], state => state.transaction.initialCall)
  },

  /**
   * evm.current
   */
  current: {
    /**
     * evm.current.callstack
     */
    callstack: state => state.evm.proc.callstack,

    /**
     * evm.current.call
     */
    call: createLeaf(
      ["./callstack"],

      stack => (stack.length ? stack[stack.length - 1] : {})
    ),

    /**
     * evm.current.context
     */
    context: createLeaf(
      [
        "./call",
        "./codex/instances",
        "/info/binaries/search",
        "/info/contexts"
      ],
      ({ address, binary }, instances, search, contexts) => {
        let contextId;
        if (address) {
          //if we're in a call to a deployed contract, we must have recorded
          //the context in the codex, so we don't need to do any further
          //searching
          ({ context: contextId, binary } = instances[address]);
        } else if (binary) {
          //otherwise, if we're in a constructor, we'll need to actually do a
          //search
          contextId = search(binary);
        } else {
          //exceptional case: no transaction is loaded
          return null;
        }

        if (contextId != undefined) {
          //if we found the context, use it
          let context = contexts[contextId];
          return {
            ...context,
            binary
          };
        } else {
          //otherwise we'll construct something default
          return {
            binary,
            isConstructor: address === undefined
            //WARNING: we've mutated binary here, so
            //instead we go by whether address is undefined
          };
        }
      }
    ),

    /**
     * evm.current.state
     *
     * evm state info: as of last operation, before op defined in step
     */
    state: Object.assign(
      {},
      ...["depth", "error", "gas", "memory", "stack", "storage"].map(param => ({
        [param]: createLeaf([trace.step], step => step[param])
      }))
    ),

    /**
     * evm.current.step
     */
    step: {
      ...createStepSelectors(trace.step, "./state"),

      //the following step selectors only exist for current, not next or any
      //other step

      /*
       * evm.current.step.createdAddress
       *
       * address created by the current create step
       */
      createdAddress: createLeaf(
        ["./isCreate", "/nextOfSameDepth/state/stack"],
        (isCreate, stack) => {
          if (!isCreate) {
            return null;
          }
          let address = stack[stack.length - 1];
          return CodecUtils.Conversion.toAddress(address);
        }
      ),

      /**
       * evm.current.step.isInstantCallOrReturn
       *
       * are we doing a call or create for which there are no trace steps?
       * This can happen if:
       * 1. we call a precompile
       * 2. we call an externally-owned account
       * 3. we do a call or create but the call stack is exhausted
       * 4. we attempt to transfer more ether than we have
       */
      isInstantCallOrCreate: createLeaf(
        ["./isCall", "./isCreate", "/current/state/depth", "/next/state/depth"],
        (calls, creates, currentDepth, nextDepth) =>
          (calls || creates) && currentDepth === nextDepth
      ),

      /**
       * evm.current.step.isContextChange
       * groups together calls, creates, halts, and exceptional halts
       */
      isContextChange: createLeaf(
        ["/current/state/depth", "/next/state/depth"],
        (currentDepth, nextDepth) => currentDepth !== nextDepth
      ),

      /**
       * evm.current.step.isExceptionalHalting
       */
      isExceptionalHalting: createLeaf(
        [
          "./isHalting",
          "/current/state/depth",
          "/next/state/depth",
          "./returnStatus"
        ],
        (halting, currentDepth, nextDepth, status) =>
          halting
            ? !status //if deliberately halting, check the return status
            : nextDepth < currentDepth //if not on a deliberate halt, any halt
        //is an exceptional halt
      ),

      /**
       * evm.current.step.returnStatus
       * checks the return status of the *current* halting instruction (for
       * normal halts only)
       * (returns a boolean -- true for success, false for failure)
       */
      returnStatus: createLeaf(
        [
          "./isHalting",
          "/next/state",
          trace.stepsRemaining,
          "/transaction/status"
        ],
        (isHalting, { stack }, remaining, finalStatus) => {
          if (!isHalting) {
            return null; //not clear this'll do much good since this may get
            //read as false, but, oh well, may as well
          }
          if (remaining <= 1) {
            return finalStatus;
          } else {
            const ZERO_WORD = "00".repeat(CodecUtils.EVM.WORD_SIZE);
            return stack[stack.length - 1] !== ZERO_WORD;
          }
        }
      )
    },

    /**
     * evm.current.codex (namespace)
     */
    codex: {
      /**
       * evm.current.codex (selector)
       * the whole codex! not that that's very much at the moment
       */
      _: createLeaf(["/state"], state => state.proc.codex),

      /**
       * evm.current.codex.storage
       * the current storage, as fetched from the codex... unless we're in a
       * failed creation call, then we just fall back on the state (which will
       * work, since nothing else can interfere with the storage of a failed
       * creation call!)
       */
      storage: createLeaf(
        ["./_", "../state/storage", "../call"],
        (codex, rawStorage, { storageAddress }) =>
          storageAddress === CodecUtils.EVM.ZERO_ADDRESS
            ? rawStorage //HACK -- if zero address ignore the codex
            : codex[codex.length - 1].accounts[storageAddress].storage
      ),

      /*
       * evm.current.codex.instances
       */
      instances: createLeaf(["./_"], codex =>
        Object.assign(
          {},
          ...Object.entries(codex[codex.length - 1].accounts).map(
            ([address, { code, context }]) => ({
              [address]: { address, binary: code, context }
            })
          )
        )
      )
    }
  },

  /**
   * evm.next
   */
  next: {
    /**
     * evm.next.state
     *
     * evm state as a result of next step operation
     */
    state: Object.assign(
      {},
      ...["depth", "error", "gas", "memory", "stack", "storage"].map(param => ({
        [param]: createLeaf([trace.next], step => step[param])
      }))
    ),

    /*
     * evm.next.step
     */
    step: createStepSelectors(trace.next, "./state")
  },

  /**
   * evm.nextOfSameDepth
   */
  nextOfSameDepth: {
    /**
     * evm.nextOfSameDepth.state
     *
     * evm state at the next step of same depth
     */
    state: Object.assign(
      {},
      ...["depth", "error", "gas", "memory", "stack", "storage"].map(param => ({
        [param]: createLeaf([trace.nextOfSameDepth], step => step[param])
      }))
    )
  }
});

export default evm;
