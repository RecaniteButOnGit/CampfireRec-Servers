import { describe, expect, it } from 'vitest'

import { guid, roomType } from '../../cv2-agent/protobuf'
import { getCv2DefinitionRegistry } from '../../cv2-agent/registry'
import { RoomDocument } from '../../cv2-agent/room'
import { RoomWorkspace } from '../../cv2-agent/workspace'

describe('CV2 codec in the Worker runtime', () => {
	it('constructs canonical chips in an empty graph with static codecs and fresh identities', () => {
		const bytes = roomType
			.encode(
				roomType.fromObject({ circuit_v2_data: { root: { graph_id: guid('11'.repeat(16)) } } })
			)
			.finish()
		const workspace = new RoomWorkspace(new RoomDocument(bytes)),
			path = [...workspace.files.keys()][0]!
		workspace.createChip(path, 0, 'Get Local Player', 'player')
		const result = workspace.compile()
		expect(result.diff.chipsCreated).toBe(1)
		expect(new RoomWorkspace(new RoomDocument(result.bytes)).nodes.size).toBe(1)
	})
	it('shares the global catalog in empty rooms without runtime code generation', () => {
		const bytes = roomType.encode(roomType.fromObject({ activity_id: 'Empty room' })).finish()
		const workspace = new RoomWorkspace(new RoomDocument(bytes))
		expect(workspace.registry).toBe(getCv2DefinitionRegistry())
		expect(
			workspace.chipDefinition('Player Get Is Grounded').globalDefinition!.outputs[0].type
		).toBe('bool')
		expect(workspace.registry.searchChips('hand velocity').total).toBeGreaterThan(0)
	})
	it('uses statically generated codecs to round trip without runtime code generation', () => {
		const bytes = roomType
			.encode(
				roomType.fromObject({
					circuit_v2_data: {
						root: {
							graph_id: guid('11'.repeat(16)),
							node_datas: [
								{
									node_id: guid('22'.repeat(16)),
									node_type: guid('33'.repeat(16)),
									node_name: 'Existing chip',
								},
							],
						},
					},
				})
			)
			.finish()
		const workspace = new RoomWorkspace(new RoomDocument(bytes))
		expect(workspace.nodes.size).toBe(1)
		expect(workspace.compile().bytes).toEqual(new Uint8Array(bytes))
	})
})
