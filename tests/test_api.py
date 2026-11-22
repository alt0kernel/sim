"""Self-contained API integration tests (Python standard library only)."""
from __future__ import annotations
import json
import subprocess
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / 'backend' / 'build' / 'saarathi_server'
PORT = 8792
BASE = f'http://127.0.0.1:{PORT}'


def req(path, obj=None):
    data = json.dumps(obj).encode() if obj is not None else None
    request = urllib.request.Request(BASE + path, data=data, headers={'Content-Type': 'application/json'} if data else {})
    with urllib.request.urlopen(request, timeout=4) as r:
        return json.load(r)


class NativeStudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SERVER.exists():
            raise RuntimeError('Compile C++ engine first: cmake -S backend -B backend/build && cmake --build backend/build')
        cls.proc = subprocess.Popen([str(SERVER), '--port', str(PORT), '--data', str(ROOT / 'data/catalogue.json')],
                                    cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(35):
            try:
                req('/api/health')
                return
            except Exception:
                time.sleep(.1)
        raise RuntimeError('C++ server did not start')

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try: cls.proc.wait(timeout=2)
        except subprocess.TimeoutExpired: cls.proc.kill()

    def action(self, key, val=None):
        return req('/api/action', {'action': key, 'value': val})

    def wait_for_state(self, condition, timeout=10):
        deadline = time.monotonic() + timeout
        while True:
            state = req('/api/state')
            if condition(state):
                return state
            if time.monotonic() >= deadline:
                self.fail(f"Timed out at {state['user']} with detour {state.get('product_detour')}")
            time.sleep(.05)

    def walk_manual_route(self, arrived):
        for _ in range(12):
            state = self.wait_for_state(lambda s: not s['walking'])
            if arrived(state):
                return state
            self.assertGreater(len(state['route']), 1, 'Expected a route for the next corridor')
            step = self.action('walk')
            self.assertTrue(step['walking'])
        self.fail('Manual walking did not reach the route destination')

    def test_01_six_store_maps_are_connected(self):
        for layout in ['standard','cross','loop','accessible','compact','superstore']:
            s = self.action('map', layout)
            self.assertEqual(s['map'], layout)
            self.assertGreaterEqual(len(s['layout']['nodes']), 8)
            for dest in [n['id'] for n in s['layout']['nodes']]:
                reached = self.action('node', dest)
                self.assertGreaterEqual(len(reached['route']), 1)
                self.assertEqual(reached['route'][-1], dest)
                self.action('reset')

    def test_02_algorithms_and_settings(self):
        for p in ['Dijkstra', 'A*', 'BFS']:
            s = self.action('planner', p)
            self.assertEqual(s['planner']['name'], p)
            self.assertEqual(len(s['comparisons']), 3)
        self.action('reset')
        dijkstra = self.action('planner', 'Dijkstra')['comparisons'][0]['cost']
        astar = self.action('planner', 'A*')['comparisons'][1]['cost']
        self.assertAlmostEqual(dijkstra, astar)
        s = self.action('profile', 'Dairy-free')
        self.assertEqual(s['profile'], 'Dairy-free')
        s = self.action('lighting', 'dim')
        self.assertEqual(s['lighting'], 'dim')
        self.assertIn('metrics', s)
        self.action('profile','Default')
        self.action('planner','Dijkstra')
        self.action('lighting','normal')

    def test_03_manual_navigation_and_obstacles(self):
        s=self.action('reset')
        self.assertTrue(s['choices'])
        s=self.action('obstacle')
        self.assertTrue(len(s['obstacles'])>0)
        s=self.action('obstacle')
        self.assertEqual(len(s['obstacles']), 0)
        self.action('option',1)
        time.sleep(.3)
        s=req('/api/state')
        self.assertGreater(s['metrics']['distance'],0)

    def test_04_autopilot_completes(self):
        self.action('reset')
        self.action('speed',4)
        self.action('mode','AUTO')
        deadline=time.monotonic()+27
        s={}
        while time.monotonic()<deadline:
            s=req('/api/state')
            if s['state']=='COMPLETE':break
            time.sleep(.25)
        self.assertEqual(s.get('state'),'COMPLETE',f"Stalled: {s.get('user')}, goal={s.get('goal')}, route={s.get('route')}")
        self.assertGreater(s['metrics']['verified'],0)
        self.assertGreater(s['metrics']['scans'],0)
        self.assertEqual(s['user']['node'],'Checkout')
        self.assertEqual(s['metrics']['verified']+s['metrics']['skipped']+s['metrics']['allergen_blocks'],s['metrics']['total'])
        saved=req('/api/export')
        self.assertEqual(saved['final_state']['state'],'COMPLETE')
        self.action('speed',1)

    def test_05_shelves_and_extra_purchase(self):
        self.action('reset')
        state=req('/api/state')
        self.assertEqual(len(state['shelves']),12)
        shelf=state['selected_shelf']
        self.assertTrue(shelf['items'])
        self.assertTrue(all(p['shelf_id']==shelf['id'] for p in shelf['items']))
        self.assertFalse(shelf['reachable'])
        extra=next((p for p in shelf['items'] if not p['in_list'] and not p['restricted'] and p['stock']>0),None)
        if extra is None:
            for sh in state['shelves']:
                shelf=self.action('select_shelf',sh['id'])['selected_shelf']
                extra=next((p for p in shelf['items'] if not p['in_list'] and not p['restricted'] and p['stock']>0),None)
                if extra:break
        self.assertIsNotNone(extra)
        with self.assertRaises(urllib.error.HTTPError):
            self.action('buy',{'sku_id':extra['id'],'quantity':1})
        # Move to the aisle corresponding to the chosen rack in manual mode.
        self.action('speed',4)
        self.action('mode','FREE')
        target=shelf['aisle']
        for _ in range(12):
            current=req('/api/state')
            if current['user']['node']==target and not current['user']['heading_to']:break
            if not current['user']['heading_to']:
                self.action('node',target)
            time.sleep(.5)
        current=req('/api/state')
        self.assertEqual(current['user']['node'],target)
        self.assertFalse(current['user']['heading_to'])
        before=next(p for p in current['selected_shelf']['items'] if p['id']==extra['id'])
        n=len(current['cart']);total=current['cart_total']
        updated=self.action('buy',{'sku_id':extra['id'],'quantity':2})
        after=next(p for p in updated['selected_shelf']['items'] if p['id']==extra['id'])
        self.assertEqual(len(updated['cart']),n+2)
        self.assertEqual(after['stock'],before['stock']-2)
        self.assertAlmostEqual(updated['cart_total'],total+2*extra['price'])
        self.assertGreaterEqual(updated['metrics']['extra_purchases'],2)
        with self.assertRaises(urllib.error.HTTPError):
            self.action('buy',{'sku_id':extra['id'],'quantity':999})
        self.action('speed',1)

    def test_06_walk_to_selected_shelf(self):
        self.action('reset')
        self.action('speed',4)
        target='Aisle_3_R'
        s=self.action('visit_shelf',target)
        self.assertEqual(s['selected_shelf']['id'],target)
        deadline=time.monotonic()+12
        while time.monotonic()<deadline:
            s=req('/api/state')
            if s['user']['node']=='Aisle_3' and not s['user']['heading_to'] and s['mode']=='FREE':break
            time.sleep(.15)
        self.assertEqual(s['user']['node'],'Aisle_3')
        self.assertEqual(s['mode'],'FREE')
        self.assertTrue(s['selected_shelf']['reachable'])
        self.action('speed',1)

    def test_07_invalid_actions_are_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as err:
            self.action('map','not-a-layout')
        self.assertEqual(err.exception.code,400)

    def test_08_extra_product_uses_shortest_route_and_preserves_list(self):
        self.action('list', 'Everyday Essentials')
        self.action('map', 'cross')
        self.action('profile', 'Default')
        self.action('chaos', False)
        self.action('planner', 'BFS')
        self.action('speed', 4)
        self.action('visit_shelf', 'Aisle_4_L')
        self.wait_for_state(lambda s: s['selected_shelf']['reachable'] and s['mode'] == 'FREE')
        self.action('buy', {'sku_id': 'A4-01', 'quantity': 1})
        before = self.action('mode', 'GUIDED')
        list_statuses = {goal['id']: goal['status'] for goal in before['goals']}
        self.assertEqual(list_statuses['A4-01'], 'found')

        route = self.action('request_product', 'Cherry Tomatoes 250 g')
        self.assertEqual(route['product_detour']['sku_id'], 'A3-06')
        self.assertNotIn('A3-06', list_statuses)
        self.assertEqual(route['route'], ['Aisle_4', 'Aisle_5', 'Central_Hub', 'Aisle_3'])
        self.assertAlmostEqual(route['route_distance'], 17.5)
        self.assertFalse(route['walking'])
        self.assertGreater(next(p['cost'] for p in route['comparisons'] if p['name'] == 'BFS'), 17.5)
        self.assertEqual(route['cart'], before['cart'])
        self.assertEqual(route['goal'], before['goal'])
        with self.assertRaises(urllib.error.HTTPError):
            self.action('buy', {'sku_id': 'A3-06', 'quantity': 1})
        time.sleep(.3)
        self.assertEqual(req('/api/state')['user'], before['user'])

        arrived = self.walk_manual_route(lambda s: (s['product_detour'] or {}).get('status') == 'arrived')
        self.assertEqual(arrived['selected_shelf']['id'], 'Aisle_3_R')
        self.assertTrue(arrived['selected_shelf']['reachable'])
        self.assertEqual(arrived['route_distance'], 0)
        bought = self.action('buy', {'sku_id': 'A3-06', 'quantity': 1})
        self.assertIsNone(bought['product_detour'])
        self.assertEqual(bought['mode'], 'GUIDED')
        self.assertEqual(bought['cart'][-1]['id'], 'A3-06')
        self.assertEqual(bought['metrics']['extra_purchases'], 1)
        self.assertEqual({goal['id']: goal['status'] for goal in bought['goals']}, list_statuses)
        self.assertEqual(bought['route'][-1], bought['goal']['node'])

    def test_09_extra_product_routes_from_inside_corridor_and_can_be_cancelled(self):
        self.action('map', 'standard')
        self.action('mode', 'FREE')
        self.action('speed', 4)
        self.action('visit_shelf', 'Aisle_4_L')
        self.wait_for_state(lambda s: s['selected_shelf']['reachable'] and s['mode'] == 'FREE')
        self.action('speed', .5)
        self.action('node', 'Aisle_5')
        before = self.wait_for_state(lambda s: s['user']['heading_to'] == 'Aisle_5' and s['user']['progress'] > .05)

        reverse = self.action('request_product', 'Honey')
        self.assertEqual(reverse['route'], ['Aisle_5', 'Aisle_4'])
        self.assertEqual(reverse['user']['heading_to'], 'Aisle_4')
        self.assertFalse(reverse['walking'])
        self.assertAlmostEqual(reverse['route_distance'], 7 * (1 - reverse['user']['progress']), delta=.02)
        self.assertAlmostEqual(reverse['user']['x'], before['user']['x'], delta=8)
        self.assertEqual(self.action('pause_detour')['product_detour']['status'], 'ready')
        time.sleep(.25)
        self.assertFalse(req('/api/state')['walking'])
        self.assertEqual(self.action('walk')['product_detour']['status'], 'en_route')
        resumed = self.action('resume_list')
        self.assertIsNone(resumed['product_detour'])
        self.assertEqual(resumed['mode'], 'FREE')
        self.assertEqual([(g['id'], g['status'], g['attempts']) for g in resumed['goals']],
                         [(g['id'], g['status'], g['attempts']) for g in before['goals']])
        self.assertEqual(resumed['cart'], before['cart'])

    def test_10_product_clarification_restrictions_and_obstacle_reroute(self):
        self.action('profile', 'Peanut Allergy')
        self.action('mode', 'FREE')
        self.action('speed', 4)
        for query, expected in [('peanut butter', 'restricted'), ('coffee', 'Which product?'),
                                ('toothpaste', 'No catalogue product')]:
            with self.assertRaises(urllib.error.HTTPError) as err:
                self.action('request_product', query)
            self.assertIn(expected, json.load(err.exception)['error'])
            self.assertIsNone(req('/api/state')['product_detour'])

        self.action('planner', 'Dijkstra')
        self.action('obstacle')
        trip = self.action('request_product', 'honey')
        self.assertEqual(trip['route'], ['Entrance', 'Aisle_4'])
        arrived = self.walk_manual_route(lambda s: (s['product_detour'] or {}).get('status') == 'arrived')
        self.assertEqual(arrived['user']['node'], 'Aisle_4')
        self.assertGreater(arrived['metrics']['distance'], 20)
        self.assertTrue(any(edge['blocked'] and {edge['a'], edge['b']} == {'Entrance', 'Aisle_4'}
                            for edge in arrived['layout']['edges']))
        self.action('profile', 'Default')
        self.action('speed', 1)

    def test_11_list_route_and_manual_scan_require_separate_purchase_confirmation(self):
        self.action('map', 'standard')
        self.action('list', 'Everyday Essentials')
        self.action('lighting', 'bright')
        self.action('speed', 4)
        shown = self.action('route_to_goal')
        self.assertEqual(shown['route'], ['Entrance', 'Aisle_4'])
        self.assertFalse(shown['walking'])

        route = self.action('request_product', 'whole milk')
        self.assertEqual(route['goal']['name'], 'Whole Milk 1L')
        self.assertIsNone(route['product_detour'])
        self.assertEqual(route['route'], ['Entrance', 'Aisle_1'])
        self.assertFalse(route['walking'])
        time.sleep(.3)
        self.assertEqual(req('/api/state')['user']['node'], 'Entrance')

        at_shelf = self.walk_manual_route(lambda s: s['user']['node'] == 'Aisle_1')
        stock_before = next(p['stock'] for p in at_shelf['selected_shelf']['items'] if p['id'] == 'A1-01')
        scanned = self.action('scan')
        self.assertEqual(scanned['scan']['outcome'], 'found')
        self.assertEqual(scanned['scan_purchase']['sku_id'], 'A1-01')
        self.assertEqual(scanned['cart'], [])
        self.assertEqual(scanned['metrics']['verified'], 0)
        self.assertEqual(next(p['stock'] for p in scanned['selected_shelf']['items'] if p['id'] == 'A1-01'), stock_before)
        dismissed = self.action('dismiss_scan', 'A1-01')
        self.assertIsNone(dismissed['scan_purchase'])
        self.assertEqual(next(g['status'] for g in dismissed['goals'] if g['id'] == 'A1-01'), 'pending')
        with self.assertRaises(urllib.error.HTTPError):
            self.action('confirm_scan', 'A1-01')

        self.action('scan')
        bought = self.action('confirm_scan', 'A1-01')
        self.assertIsNone(bought['scan_purchase'])
        self.assertEqual(bought['scan']['outcome'], 'verified')
        self.assertEqual([p['id'] for p in bought['cart']], ['A1-01'])
        self.assertEqual(bought['metrics']['verified'], 1)
        self.assertEqual(next(p['stock'] for p in bought['selected_shelf']['items'] if p['id'] == 'A1-01'), stock_before - 1)
        with self.assertRaises(urllib.error.HTTPError):
            self.action('confirm_scan', 'A1-01')
        self.action('speed', 1)

if __name__ == '__main__': unittest.main(verbosity=2)
