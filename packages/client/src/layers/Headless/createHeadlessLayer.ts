import {
  defineComponent,
  Type,
  namespaceWorld,
  getComponentValue,
  hasComponent,
  runQuery,
  Has,
  HasValue,
  Not,
  getComponentValueStrict,
  Component,
  Entity,
} from "@latticexyz/recs";
import { attack } from "./api";
import { isPassive, isNeutralStructure, canRetaliate } from "./utils";

import { NetworkLayer, StructureTypes } from "../Network";
import { createCurrentStaminaSystem, createScopeClientToMatchSystem } from "./systems";
import lodash from "lodash";
import { createTurnStream } from "./setup";
import { getClosestTraversablePositionToTarget, manhattan } from "../../utils/distance";
import { WorldCoord } from "../../types";
import { createCooldownSystem } from "./systems/CooldownSystem";
import { aStar } from "../../utils/pathfinding";
import { BigNumber } from "ethers";
import { createPreviousOwnerSystem } from "./systems/PreviousOwnerSystem";
import { decodeMatchEntity } from "../../decodeMatchEntity";

const { curry } = lodash;

/**
 * The Headless layer is the second layer in the client architecture and extends the Network layer.
 * Its purpose is to provide an API that allows the game to be played programatically.
 */

export async function createHeadlessLayer(network: NetworkLayer) {
  const world = namespaceWorld(network.network.world, "headless");
  const {
    utils: { getOwningPlayer, isOwnedBy },
    api: { getCurrentMatchConfig },
    network: {
      clock,
      components: {
        Combat,
        Movable,
        MoveDifficulty,
        OwnedBy,
        Position,
        Range,
        Stamina,
        StructureType,
        TerrainType,
        UnitType,
        Untraversable,
        Chargee,
        Charger,
      },
    },
  } = network;

  const LocalStamina = defineComponent(world, { current: Type.Number }, { id: "LocalStamina" });
  const NextPosition = defineComponent(
    world,
    {
      x: Type.Number,
      y: Type.Number,
      userCommittedToPosition: Type.Boolean,
      intendedTarget: Type.OptionalEntity,
    },
    { id: "NextPosition" }
  );
  const OnCooldown = defineComponent(world, { value: Type.Boolean }, { id: "OnCooldown" });
  const Depleted = defineComponent(world, { value: Type.Boolean }, { id: "Depleted" });
  const InCurrentMatch = defineComponent(world, { value: Type.Boolean }, { id: "InCurrentMatch" });
  const PreviousOwner = defineComponent(world, { value: Type.Entity }, { id: "PreviousOwner" });

  const components = { LocalStamina, OnCooldown, NextPosition, Depleted, InCurrentMatch, PreviousOwner };

  const turn$ = createTurnStream(() => {
    const matchConfig = getCurrentMatchConfig();
    if (!matchConfig) return undefined;

    return {
      startTime: BigNumber.from(matchConfig.startTime),
      turnLength: BigNumber.from(matchConfig.turnLength),
    };
  }, clock);

  const getCurrentStamina = (entity: Entity) => {
    const contractStamina = getComponentValue(Stamina, entity)?.current;
    if (contractStamina == undefined) return 0;

    const localStamina = getComponentValue(LocalStamina, entity)?.current;
    if (localStamina == undefined) return 0;

    return contractStamina + localStamina;
  };

  const getActionStaminaCost = () => {
    return 1_000;
  };

  const isUntraversable = (
    positionComponent: Component<{ x: Type.Number; y: Type.Number }>,
    playerEntity: Entity,
    isFinalPosition: boolean,
    position: WorldCoord
  ) => {
    const blockingEntities = runQuery([Has(InCurrentMatch), HasValue(positionComponent, position), Has(Untraversable)]);

    const foundBlockingEntity = blockingEntities.size > 0;
    if (!foundBlockingEntity) return false;
    if (isFinalPosition) return true;

    const blockingEntity = [...blockingEntities][0];

    if (hasComponent(StructureType, blockingEntity)) {
      return getComponentValueStrict(StructureType, blockingEntity).value !== StructureTypes.Container;
    }

    if (!isOwnedBy(blockingEntity, playerEntity)) return true;

    return false;
  };

  const getMovementDifficulty = (
    positionComponent: Component<{ x: Type.Number; y: Type.Number }>,
    targetPosition: WorldCoord
  ) => {
    const entity = [...runQuery([HasValue(positionComponent, targetPosition), Has(MoveDifficulty)])][0];
    if (entity == null) return Infinity;

    return getComponentValueStrict(MoveDifficulty, entity).value;
  };

  function unitSort(a: Entity, b: Entity) {
    const aOutOfStamina = getCurrentStamina(a) < 1000;
    const bOutOfStamina = getCurrentStamina(b) < 1000;

    if (aOutOfStamina && !bOutOfStamina) return 1;
    if (bOutOfStamina && !aOutOfStamina) return -1;

    const aUnitType = getComponentValue(UnitType, a)?.value;
    const bUnitType = getComponentValue(UnitType, b)?.value;

    if (aUnitType && bUnitType && aUnitType !== bUnitType) {
      return bUnitType - aUnitType;
    }

    const aStructureType = getComponentValue(StructureType, a)?.value;
    const bStructureType = getComponentValue(StructureType, b)?.value;

    if (aStructureType && bStructureType && aStructureType !== bStructureType) {
      return bStructureType - aStructureType;
    }

    if (aUnitType && bStructureType) {
      return -1;
    }

    if (aStructureType && bUnitType) {
      return 1;
    }

    return 0;
  }

  const canAttack = (attacker: Entity, defender: Entity) => {
    const onCooldown = getComponentValue(OnCooldown, attacker);
    if (onCooldown) return false;

    const attackerOwner = getComponentValue(OwnedBy, attacker);
    const defenderOwner = getComponentValue(OwnedBy, defender);

    if (!attackerOwner) return false;
    if (attackerOwner.value === defenderOwner?.value) return false;

    const combat = getComponentValue(Combat, defender);
    if (!combat) return false;

    const attackerPosition = getComponentValue(Position, attacker);
    if (!attackerPosition) return;

    const defenderPosition = getComponentValue(Position, defender);
    if (!defenderPosition) return;

    const distanceToTarget = manhattan(attackerPosition, defenderPosition);

    const attackerRange = getComponentValue(Range, attacker);
    if (!attackerRange) return;
    if (attackerRange && (distanceToTarget > attackerRange.max || distanceToTarget < attackerRange.min)) return false;

    return true;
  };

  function getEntitiesInRange(from: WorldCoord, minRange: number, maxRange: number) {
    const entities = [];
    for (let y = from.y - maxRange; y <= from.y + maxRange; y++) {
      for (let x = from.x - maxRange; x <= from.x + maxRange; x++) {
        const distanceTo = manhattan(from, { x, y });
        if (distanceTo >= minRange && distanceTo <= maxRange) {
          const entity = [...runQuery([Has(InCurrentMatch), HasValue(Position, { x: x, y: y }), Not(TerrainType)])][0];
          if (entity) entities.push(entity);
        }
      }
    }
    return entities;
  }

  const getAttackableEntities = (attacker: Entity, atCoord?: WorldCoord) => {
    const attackerOwner = getComponentValue(OwnedBy, attacker);
    if (!attackerOwner) return;

    if (!atCoord) atCoord = getComponentValue(Position, attacker);
    if (!atCoord) return;

    const attackerRange = getComponentValue(Range, attacker);
    let entities;
    if (attackerRange) {
      entities = getEntitiesInRange(atCoord, attackerRange.min, attackerRange.max);
    } else {
      entities = getEntitiesInRange(atCoord, 1, 1);
    }

    const attackableEntities: Entity[] = [];
    for (const defender of entities) {
      const combat = getComponentValue(Combat, defender);
      if (!combat) continue;

      const defenderOwner = getComponentValue(OwnedBy, defender);
      if (attackerOwner.value === defenderOwner?.value) continue;

      attackableEntities.push(defender);
    }
    return attackableEntities;
  };

  const getMoveSpeed = (entity: Entity) => {
    const moveSpeed = getComponentValue(Movable, entity)?.value;
    if (!moveSpeed) return;

    return moveSpeed;
  };

  const calculateMovementPath = (
    positionComponent: Component<{ x: Type.Number; y: Type.Number }>,
    entity: Entity,
    pos1: WorldCoord,
    pos2: WorldCoord
  ) => {
    const player = getOwningPlayer(entity);
    const moveSpeed = getMoveSpeed(entity);

    if (!player || !moveSpeed) return [];

    return aStar(
      pos1,
      pos2,
      moveSpeed / 1_000,
      (targetPosition: WorldCoord) => {
        return getMovementDifficulty(positionComponent, targetPosition) / 1_000;
      },
      curry(isUntraversable)(positionComponent, player)
    );
  };

  const getMoveAndAttackPath = (
    positionComponent: Component<{ x: Type.Number; y: Type.Number }>,
    attacker: Entity,
    defender: Entity,
    preferredEndPosition?: WorldCoord
  ) => {
    if (hasComponent(OnCooldown, attacker)) return [];

    const attackerPosition = getComponentValue(positionComponent, attacker);
    if (!attackerPosition) return [];

    const defenderPosition = getComponentValue(positionComponent, defender);
    if (!defenderPosition) return [];

    const attackerRange = getComponentValue(Range, attacker);
    if (!attackerRange) return [];

    if (preferredEndPosition) {
      const distanceToTarget = manhattan(preferredEndPosition, defenderPosition);
      if (distanceToTarget <= attackerRange.max && distanceToTarget >= attackerRange.min) {
        const pathToPreferredPosition = calculateMovementPath(
          positionComponent,
          attacker,
          attackerPosition,
          preferredEndPosition
        );
        if (pathToPreferredPosition.length > 0) {
          return pathToPreferredPosition;
        }
      }
    }

    const isTraversable = (entity: Entity, pos: WorldCoord) => {
      const nextPositionAtLocation = [
        ...runQuery([HasValue(NextPosition, { x: pos.x, y: pos.y, userCommittedToPosition: true })]),
      ].filter((e) => e !== attacker);
      if (nextPositionAtLocation.length > 0) return false;

      return calculateMovementPath(positionComponent, entity, attackerPosition, pos).length > 0;
    };

    const closestUnblockedPosition = getClosestTraversablePositionToTarget(
      Position,
      isTraversable,
      attacker,
      defender,
      attackerRange.min,
      attackerRange.max
    );
    if (!closestUnblockedPosition) return [];

    return calculateMovementPath(positionComponent, attacker, attackerPosition, closestUnblockedPosition);
  };

  const getCurrentRegen = (entity: Entity) => {
    const chargers = runQuery([Has(InCurrentMatch), HasValue(Chargee, { value: decodeMatchEntity(entity).entity })]);
    const regen = [...chargers].reduce((acc, charger) => {
      if (hasComponent(Depleted, charger)) return acc;

      const chargeValue = getComponentValue(Charger, charger)?.value;
      if (!chargeValue) return acc;
      return acc + chargeValue;
    }, 0);

    return regen;
  };

  const layer = {
    world,
    parentLayers: { network },
    components,
    turn$,
    api: {
      attack: curry(attack)({ network }),

      canAttack,
      isUntraversable,
      getMovementDifficulty,
      getAttackableEntities,

      unitSort,
      getCurrentStamina,

      calculateMovementPath,
      getMoveAndAttackPath,
      getMoveSpeed,
      getActionStaminaCost,

      getCurrentRegen,

      combat: { isPassive, isNeutralStructure, canRetaliate },
    },
  };

  createCurrentStaminaSystem(layer);
  createCooldownSystem(layer);
  createScopeClientToMatchSystem(layer);
  createPreviousOwnerSystem(layer);

  return layer;
}
