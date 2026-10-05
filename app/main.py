# app/main.py
from bottle import Bottle, run, response, request, template, TEMPLATE_PATH, static_file
from iiif2annos.ocr import OCR, get_languages
from io import BytesIO
import hashlib
import json
import os
import re
import requests
import uuid
import zipfile


def _region_slug_for_annotation(annotation):
    selector = annotation.get('target', {}).get('selector', {}).get('value', '')
    m = re.search(r'xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)', selector)
    if not m:
        return None
    return f"{round(float(m.group(1)))}-{round(float(m.group(2)))}-{round(float(m.group(3)))}-{round(float(m.group(4)))}"


def _has_ocr(article, ocr_dir):
    for annotation in article.get('annotations', []):
        slug = _region_slug_for_annotation(annotation)
        if slug and os.path.exists(os.path.join(ocr_dir, f'{slug}-{annotation["id"]}.json')):
            return True
    return False


def _sort_boxes_reading_order(boxes):
    """Sort region boxes in column-aware reading order.

    Groups boxes into columns by horizontal overlap: two boxes belong to the
    same column if their X extents overlap by more than 20% of the narrower
    box's width.  Columns are then ordered left-to-right, and boxes within
    each column are ordered top-to-bottom by Y.

    This correctly handles the case where one column's region sits much higher
    on the page than a region in the left column — the left column is still
    read first.
    """
    n = len(boxes)
    if n <= 1:
        return list(boxes)

    # Union-Find to cluster boxes into columns by horizontal overlap
    group = list(range(n))

    def find(i):
        while group[i] != i:
            group[i] = group[group[i]]
            i = group[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            a, b = boxes[i], boxes[j]
            overlap = min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x'])
            if overlap > min(a['w'], b['w']) * 0.2:
                group[find(i)] = find(j)

    # Collect columns
    cols = {}
    for i in range(n):
        root = find(i)
        cols.setdefault(root, []).append(boxes[i])

    # Sort columns left-to-right; within each column sort top-to-bottom
    ordered = []
    for col in sorted(cols.values(), key=lambda c: min(b['x'] for b in c)):
        ordered.extend(sorted(col, key=lambda b: b['y']))
    return ordered


def _words_to_lines(words):
    """Group OCR word dicts into lines using Y-centre proximity.

    Threshold is half the average word height.  Words within each line are
    returned sorted left-to-right by X.
    """
    if not words:
        return []
    avg_h = sum(w['h'] for w in words) / len(words)
    threshold = avg_h * 0.5
    words_sorted = sorted(words, key=lambda w: w['y'] + w['h'] / 2)
    lines, current_line = [], [words_sorted[0]]
    current_y = words_sorted[0]['y'] + words_sorted[0]['h'] / 2
    for word in words_sorted[1:]:
        wy = word['y'] + word['h'] / 2
        if abs(wy - current_y) <= threshold:
            current_line.append(word)
            current_y = sum(w['y'] + w['h'] / 2 for w in current_line) / len(current_line)
        else:
            lines.append(sorted(current_line, key=lambda w: w['x']))
            current_line, current_y = [word], wy
    lines.append(sorted(current_line, key=lambda w: w['x']))
    return lines


def _first_annotation_coords(obj):
    annotations = obj.get('annotations', [])
    if not annotations:
        return (float('inf'), float('inf'))
    selector = annotations[0].get('target', {}).get('selector', {}).get('value', '')
    m = re.search(r'xywh=pixel:([\d.]+),([\d.]+)', selector)
    if m:
        return (float(m.group(1)), float(m.group(2)))  # (x, y)
    return (float('inf'), float('inf'))

def create_app():
    app = Bottle()

    BASE_DIR = os.path.dirname(__file__)
    ANNOTATIONS_DIR = os.path.join(BASE_DIR, '..', 'annotations')
    os.makedirs(ANNOTATIONS_DIR, exist_ok=True)
    LINKS_DIR = os.path.join(BASE_DIR, '..', 'links')
    os.makedirs(LINKS_DIR, exist_ok=True)
    OCR_DIR = os.path.join(BASE_DIR, '..', 'ocr')
    os.makedirs(OCR_DIR, exist_ok=True)
    TEMPLATE_PATH.insert(0, os.path.join(BASE_DIR, "templates"))
    OSD_IMAGES =  os.path.join( BASE_DIR, "..", "node_modules", "openseadragon", "build", "openseadragon", "images")

    @app.hook('after_request')
    def enable_cors():
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'

    @app.route('/<path:path>', method='OPTIONS')
    def options_handler(path):
        return {}

    MANIFESTS_DIR = os.path.join(BASE_DIR, '..', 'manifests')

    @app.route("/")
    def index():
        return template("index.html")

    @app.route("/segmentation")
    def segmentation():
        return template("segmentation.html")

    @app.route("/ocr")
    def ocr():
        return template("ocr.html")

    @app.route("/link-articles")
    def link_articles():
        return template("link-articles.html")

    @app.route("/export")
    def export_page():
        return template("export.html")

    @app.route("/api/manifests")
    def list_manifests():
        manifests = []
        if os.path.isdir(MANIFESTS_DIR):
            for fname in sorted(os.listdir(MANIFESTS_DIR)):
                if not fname.endswith('.json'):
                    continue
                fpath = os.path.join(MANIFESTS_DIR, fname)
                try:
                    with open(fpath) as f:
                        manifest = json.load(f)
                    label_obj = manifest.get('label', {})
                    label = fname
                    for lang_vals in label_obj.values():
                        if lang_vals:
                            label = lang_vals[0]
                            break
                    url = f"{request.urlparts.scheme}://{request.urlparts.netloc}/manifests/{fname}"
                    manifests.append({'label': label, 'url': url})
                except Exception:
                    pass
        response.content_type = 'application/json'
        return json.dumps(manifests)

    @app.route("/health")
    def health():
        response.content_type = "application/json"
        return {"status": "ok"}

    @app.route('/api/languages')
    def list_languages():
        langs = sorted(l for l in get_languages() if l != 'osd')
        response.content_type = 'application/json'
        return json.dumps(langs)

    @app.route('/js/<filename:path>')
    def serve_js(filename):
        return static_file(filename, root='./app/static/js')

    @app.route('/css/<filename:path>')
    def serve_css(filename):
        return static_file(filename, root='./app/static/css')

    @app.route('/manifests/<filename:path>')
    def serve_manifests(filename):
        print (f" Serving manifest: {filename}")
        return static_file(filename, root='./manifests')

    @app.route('/api/annotations', method='POST')
    def save_annotations():
        data = request.json
        article_id = str(uuid.uuid4())
        article = {
            'id': article_id,
            'title': data['title'],
            'canvasId': data['canvasId'],
            'manifestId': data['manifestId'],
            'annotations': data['annotations'],
        }

        filepath = os.path.join(ANNOTATIONS_DIR, article_id + '.json')




        with open(filepath, 'w') as f:
            json.dump(article, f, indent=2)

        response.content_type = 'application/json'
        return json.dumps({'status': 'ok', 'id': article_id, 'title': article['title']})

    @app.route('/api/articles')
    def list_articles():
        canvas_id = request.query.canvasId
        articles = []
        for fname in os.listdir(ANNOTATIONS_DIR):
            if not fname.endswith('.json'):
                continue
            with open(os.path.join(ANNOTATIONS_DIR, fname)) as f:
                obj = json.load(f)
            if obj.get('canvasId') == canvas_id:
                articles.append(obj)

        articles.sort(key=_first_annotation_coords)

        response.content_type = 'application/json'
        return json.dumps([{'id': a['id'], 'title': a['title'], 'hasOCR': _has_ocr(a, OCR_DIR)} for a in articles])

    @app.route('/api/annotations/<article_id>')
    def get_annotations(article_id):
        filepath = os.path.join(ANNOTATIONS_DIR, article_id + '.json')
        with open(filepath) as f:
            obj = json.load(f)
        response.content_type = 'application/json'
        return json.dumps(obj)

    @app.route('/api/annotations/<article_id>', method='PATCH')
    def patch_article(article_id):
        filepath = os.path.join(ANNOTATIONS_DIR, article_id + '.json')
        with open(filepath) as f:
            obj = json.load(f)
        data = request.json
        if 'title' in data:
            obj['title'] = data['title']
        with open(filepath, 'w') as f:
            json.dump(obj, f, indent=2)
        response.content_type = 'application/json'
        return json.dumps({'status': 'ok', 'title': obj['title']})

    @app.route('/api/annotations/<article_id>', method='PUT')
    def update_annotations(article_id):
        filepath = os.path.join(ANNOTATIONS_DIR, article_id + '.json')
        with open(filepath) as f:
            obj = json.load(f)
        obj['annotations'] = request.json['annotations']
        with open(filepath, 'w') as f:
            json.dump(obj, f, indent=2)
        response.content_type = 'application/json'
        return json.dumps({'status': 'ok'})

    def _links_path(manifest_url):
        key = hashlib.md5(manifest_url.encode()).hexdigest()
        return os.path.join(LINKS_DIR, key + '.json')

    def _load_links(manifest_url):
        path = _links_path(manifest_url)
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return json.load(f)

    def _save_links(manifest_url, links):
        with open(_links_path(manifest_url), 'w') as f:
            json.dump(links, f, indent=2)

    @app.route('/api/links', method='GET')
    def get_links():
        manifest_url = request.query.get('manifest', '')
        links = _load_links(manifest_url) if manifest_url else []
        response.content_type = 'application/json'
        return json.dumps(links)

    @app.route('/api/articles/<article_id>/link', method='POST')
    def add_link(article_id):
        data = request.json
        linked_id = data['linkedId']
        manifest_url = data.get('manifestUrl', '')
        linked_canvas_label = data.get('linkedCanvasLabel', '')
        source_canvas_label = data.get('sourceCanvasLabel', '')

        a_path = os.path.join(ANNOTATIONS_DIR, article_id + '.json')
        b_path = os.path.join(ANNOTATIONS_DIR, linked_id + '.json')
        with open(a_path) as f:
            a = json.load(f)
        with open(b_path) as f:
            b = json.load(f)

        entries = _load_links(manifest_url)
        group = next((e for e in entries if any(l['id'] == article_id for l in e['links'])), None)

        if group is None:
            group = {
                'id': str(uuid.uuid4()),
                'title': a['title'],
                'links': [{'id': a['id'], 'title': a['title'], 'canvasLabel': source_canvas_label}],
            }
            entries.append(group)

        if not any(l['id'] == linked_id for l in group['links']):
            group['links'].append({'id': b['id'], 'title': b['title'], 'canvasLabel': linked_canvas_label})

        _save_links(manifest_url, entries)
        response.content_type = 'application/json'
        return json.dumps({'status': 'ok'})

    @app.route('/api/links/<group_id>', method='DELETE')
    def delete_link_group(group_id):
        manifest_url = request.query.get('manifest', '')
        entries = _load_links(manifest_url)
        entries = [e for e in entries if e['id'] != group_id]
        _save_links(manifest_url, entries)
        response.content_type = 'application/json'
        return json.dumps({'status': 'ok'})

    @app.route('/api/export', method='POST')
    def export():
        data = request.json
        manifest_url = data.get('manifestUrl', '')
        article_ids = data.get('articleIds', [])
        base_url = data.get('baseUrl', '').rstrip('/')

        manifest = requests.get(manifest_url).json()
        structures = []
        buf = BytesIO()

        # Resolve article_ids into export units, merging linked articles
        links = _load_links(manifest_url)
        article_to_group = {
            link['id']: group
            for group in links
            for link in group['links']
        }
        processed_group_ids = set()
        export_units = []
        for article_id in article_ids:
            group = article_to_group.get(article_id)
            if group and group['id'] not in processed_group_ids:
                processed_group_ids.add(group['id'])
                export_units.append({
                    'unit_id': group['id'],
                    'unit_title': group['title'],
                    'article_ids': [l['id'] for l in group['links']],
                })
            elif not group:
                export_units.append({
                    'unit_id': article_id,
                    'unit_title': None,
                    'article_ids': [article_id],
                })

        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for unit in export_units:
                unit_id = unit['unit_id']
                unit_title = unit['unit_title']
                zones = []    # [{anno_id, zone_id, ocr_items}]
                range_items = []

                # First pass: collect all zones across all articles in the unit
                for article_id in unit['article_ids']:
                    anno_path = os.path.join(ANNOTATIONS_DIR, article_id + '.json')
                    if not os.path.exists(anno_path):
                        continue
                    with open(anno_path) as f:
                        article = json.load(f)

                    if not unit_title:
                        unit_title = article.get('title', article_id)

                    canvas_id = article.get('canvasId', '')

                    for annotation in article.get('annotations', []):
                        slug = _region_slug_for_annotation(annotation)
                        if not slug:
                            continue
                        anno_id = annotation['id']

                        ocr_path = os.path.join(OCR_DIR, f'{slug}-{anno_id}.json')
                        ocr_items = []
                        if os.path.exists(ocr_path):
                            with open(ocr_path) as f:
                                ocr_items = json.load(f).get('annotations', [])

                        zone_id = f'{base_url}/annotations/{unit_id}/{anno_id}'
                        zones.append({'anno_id': anno_id, 'zone_id': zone_id, 'ocr_items': ocr_items})

                        sel = annotation.get('target', {}).get('selector', {}).get('value', '')
                        m = re.search(r'xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)', sel)
                        if m:
                            x, y, w, h = [round(float(v)) for v in m.groups()]
                            # {
                            # "type": "SpecificResource",
                            # "source": {
                            # "id": "http://localhost:4000/recipe/0025-newspaper-article-index/canvas/p5",
                            #  "type": "Canvas"
                            # },
                            # "selector": {
                            #  "type": "FragmentSelector",
                            # "value": "xywh=1044,104,466,2147"
                            #   }
                            # }
                            range_items.append({
                                "type":"SpecificResource",
                                "source": {
                                    'id': f'{canvas_id}', 
                                    'type': 'Canvas'
                                },
                                "selector": {
                                    "type": "FragmentSelector",
                                    "value": f"xywh={x},{y},{w},{h}"
                                }
                            })

                # Second pass: write AnnotationPages with partOf and next links
                collection_id = f'{base_url}/annotations/{unit_id}'
                for i, zone in enumerate(zones):
                    page = {
                        '@context': 'http://iiif.io/api/presentation/3/context.json',
                        'id': zone['zone_id'],
                        'type': 'AnnotationPage',
                        'partOf': [{'id': collection_id, 'type': 'AnnotationCollection'}], # must be an array
                        **({'next': {'id': zones[i + 1]['zone_id'], 'type': 'AnnotationPage'}} if i < len(zones) - 1 else {}),
                        'items': zone['ocr_items'],
                    }
                    zf.writestr(
                        f'annotations/{unit_id}/{zone["anno_id"]}.json',
                        json.dumps(page, indent=2)
                    )

                # AnnotationCollection with first/last, no items
                collection = {
                    '@context': 'http://iiif.io/api/presentation/3/context.json',
                    'id': collection_id,
                    'type': 'AnnotationCollection',
                    'label': {'none': [unit_title or unit_id]},
                }
                if zones:
                    collection['first'] = {'id': zones[0]['zone_id'], 'type': 'AnnotationPage'}
                    collection['last'] = {'id': zones[-1]['zone_id'], 'type': 'AnnotationPage'}
                zf.writestr(
                    f'annotations/{unit_id}.json',
                    json.dumps(collection, indent=2)
                )

                # Range for manifest structures
                structures.append({
                    'id': f'{base_url}/range/{unit_id}',
                    'type': 'Range',
                    'label': {'none': [unit_title or unit_id]},
                    'items': range_items,
                    'supplementary': {'id': f"{collection_id}.json", 'type': 'AnnotationCollection'},
                })

            # Parent "Articles" Range wrapping all article ranges
            articles_range = {
                'id': f'{base_url}/range/articles',
                'type': 'Range',
                'label': {'none': ['Articles']},
                'items': structures,
            }
            all_structures = [articles_range]

            # manifest.json — append new structures after any existing ones
            manifest.setdefault('structures', []).extend(all_structures)
            zf.writestr('manifest.json', json.dumps(manifest, indent=2))

            # structures.json as standalone file
            zf.writestr('structures.json', json.dumps({
                '@context': 'http://iiif.io/api/presentation/3/context.json',
                'structures': all_structures,
            }, indent=2))

        buf.seek(0)
        response.content_type = 'application/zip'
        response.headers['Content-Disposition'] = 'attachment; filename="export.zip"'
        return buf.read()

    @app.route('/api/ocr/<article_id>/word', method='DELETE')
    def delete_ocr_word(article_id):
        annotation_id = request.json['annotationId']
        with open(os.path.join(ANNOTATIONS_DIR, article_id + '.json')) as f:
            article = json.load(f)
        for annotation in article.get('annotations', []):
            slug = _region_slug_for_annotation(annotation)
            if not slug:
                continue
            part_path = os.path.join(OCR_DIR, f'{slug}-{annotation["id"]}.json')
            if not os.path.exists(part_path):
                continue
            with open(part_path) as f:
                part = json.load(f)
            original_len = len(part['annotations'])
            part['annotations'] = [a for a in part['annotations'] if a['id'] != annotation_id]
            if len(part['annotations']) != original_len:
                with open(part_path, 'w') as f:
                    json.dump(part, f, indent=2)
                response.content_type = 'application/json'
                return json.dumps({'status': 'ok'})
        response.status = 404
        return json.dumps({'error': 'not found'})

    @app.route('/api/ocr/<article_id>/word', method='PATCH')
    def patch_ocr_word(article_id):
        data = request.json
        annotation_id = data['annotationId']
        value = data['value']
        with open(os.path.join(ANNOTATIONS_DIR, article_id + '.json')) as f:
            article = json.load(f)
        for annotation in article.get('annotations', []):
            slug = _region_slug_for_annotation(annotation)
            if not slug:
                continue
            part_path = os.path.join(OCR_DIR, f'{slug}-{annotation["id"]}.json')
            if not os.path.exists(part_path):
                continue
            with open(part_path) as f:
                part = json.load(f)
            for a in part['annotations']:
                if a['id'] == annotation_id:
                    bodies = a['body'] if isinstance(a['body'], list) else [a['body']]
                    for b in bodies:
                        if b.get('type') == 'TextualBody':
                            b['value'] = value
                    with open(part_path, 'w') as f:
                        json.dump(part, f, indent=2)
                    response.content_type = 'application/json'
                    return json.dumps({'status': 'ok'})
        response.status = 404
        return json.dumps({'error': 'not found'})

    @app.route('/api/ocr/<article_id>', method='POST')
    def generate_ocr(article_id):
        data = request.json
        annotation_id = data['annotationId']
        region = data['region']

        with open(os.path.join(ANNOTATIONS_DIR, article_id + '.json')) as f:
            article = json.load(f)

        manifest = requests.get(article['manifestId']).json()

        lang = data.get('lang') or None
        region_slug = region.replace(',', '-')
        base = f"{request.urlparts.scheme}://{request.urlparts.netloc}/api/ocr/{article_id}/{region_slug}/annos/"
        ocr = OCR(base=base, lang=lang)
        ocr_annos = ocr.ocr_region(manifest, article['canvasId'], region)
        for anno in ocr_annos:
            anno['motivation'] = 'supplementing'

        part = {
            'articleId': article_id,
            'annotationId': annotation_id,
            'canvasId': article['canvasId'],
            'region': region,
            'annotations': ocr_annos,
        }
        part_path = os.path.join(OCR_DIR, f'{region_slug}-{annotation_id}.json')
        with open(part_path, 'w') as f:
            json.dump(part, f, indent=2)

        response.content_type = 'application/json'
        return json.dumps({'status': 'ok', 'annotations': len(ocr_annos)})

    @app.route('/api/articles/<article_id>/text')
    def article_text(article_id):
        with open(os.path.join(ANNOTATIONS_DIR, article_id + '.json')) as f:
            article = json.load(f)

        boxes = []
        for annotation in article.get('annotations', []):
            slug = _region_slug_for_annotation(annotation)
            if not slug:
                continue
            part_path = os.path.join(OCR_DIR, f'{slug}-{annotation["id"]}.json')
            if not os.path.exists(part_path):
                continue
            with open(part_path) as f:
                part = json.load(f)

            sel = annotation.get('target', {}).get('selector', {}).get('value', '')
            m = re.search(r'xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)', sel)
            if not m:
                continue
            bx, by, bw, bh = (float(m.group(i)) for i in range(1, 5))

            words = []
            for ocr_anno in part.get('annotations', []):
                target = ocr_anno.get('target', '')
                tm = re.search(r'#xywh=([\d.]+),([\d.]+),([\d.]+),([\d.]+)', target) if isinstance(target, str) else None
                if not tm:
                    continue
                wx, wy, ww, wh = (float(tm.group(i)) for i in range(1, 5))
                body = ocr_anno.get('body', {})
                bodies = body if isinstance(body, list) else [body]
                tb = next((b for b in bodies if b.get('type') == 'TextualBody'), None)
                text = tb.get('value', '').strip() if tb else ''
                if text:
                    words.append({'x': wx, 'y': wy, 'w': ww, 'h': wh, 'text': text})

            if words:
                boxes.append({'x': bx, 'y': by, 'w': bw, 'h': bh, 'words': words})

        ordered_boxes = _sort_boxes_reading_order(boxes)
        box_texts = []
        for box in ordered_boxes:
            lines = _words_to_lines(box['words'])
            box_texts.append('\n'.join(' '.join(w['text'] for w in line) for line in lines))

        response.content_type = 'text/plain; charset=utf-8'
        return '\n\n'.join(box_texts)

    @app.route('/api/ocr/article/<article_id>')
    def get_article_ocr(article_id):
        with open(os.path.join(ANNOTATIONS_DIR, article_id + '.json')) as f:
            article = json.load(f)
        regions = []
        for annotation in article.get('annotations', []):
            slug = _region_slug_for_annotation(annotation)
            if not slug:
                continue
            part_path = os.path.join(OCR_DIR, f'{slug}-{annotation["id"]}.json')
            if os.path.exists(part_path):
                with open(part_path) as f:
                    regions.append(json.load(f))
        response.content_type = 'application/json'
        return json.dumps({'hasOCR': len(regions) > 0, 'regions': regions})

    @app.route('/api/ocr/region/<article_id>/<region>/<annotation_id>')
    def get_ocr_region(article_id, region, annotation_id):
        region_slug = region.replace(',', '-')
        filepath = os.path.join(OCR_DIR, f'{region_slug}-{annotation_id}.json')
        if not os.path.exists(filepath):
            response.status = 404
            return json.dumps({'error': 'not found'})
        with open(filepath) as f:
            return json.dumps(json.load(f))

    @app.route('/images/<filename:path>')
    def serve_osd_images(filename):
        print (f"Looking in {OSD_IMAGES} for {filename}")
        return static_file(filename, root=OSD_IMAGES)    

    return app


def main():
    app = create_app()
    run(app, host="127.0.0.1", port=8080, debug=True, reloader=True, server='waitress')


if __name__ == "__main__":
    main()