import { describe, expect, it } from 'vitest'

import { guid, roomType } from '../../cv2-agent/protobuf'
import { RoomDocument } from '../../cv2-agent/room'
import { RoomWorkspace } from '../../cv2-agent/workspace'

describe('CV2 codec in the Worker runtime', () => {
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
