
import copy
import re
from datetime import date, datetime
from typing import Any, Dict, Optional

import httpx


def _json(v):
    if isinstance(v, datetime): return v.isoformat()
    if isinstance(v, date): return v.isoformat()
    if isinstance(v, list): return [_json(x) for x in v]
    if isinstance(v, dict): return {k: _json(x) for k, x in v.items()}
    return v


def _restore(v):
    if isinstance(v, list): return [_restore(x) for x in v]
    if isinstance(v, dict): return {k: _restore(x) for k, x in v.items()}
    if isinstance(v, str) and "T" in v:
        try: return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError: pass
    return v


class Result:
    def __init__(self, matched_count=0, modified_count=0, deleted_count=0):
        self.matched_count = matched_count
        self.modified_count = modified_count
        self.deleted_count = deleted_count


class Cursor:
    def __init__(self, table, query, projection):
        self.table, self.query, self.projection = table, query, projection
        self._sort, self._limit = [], None

    def sort(self, spec, direction=None):
        self._sort = [(spec, int(direction or 1))] if isinstance(spec, str) else [(str(k), int(v)) for k, v in spec]
        return self

    def limit(self, n): self._limit = n; return self

    async def to_list(self, length=1000):
        rows = await self.table._rows(self.query, self.projection)
        for field, direction in reversed(self._sort):
            rows.sort(key=lambda r: (r.get(field) is None, r.get(field)), reverse=direction < 0)
        return rows[:self._limit if self._limit is not None else length]


class Table:
    def __init__(self, db, name): self.db, self.name = db, name

    def find(self, query=None, projection=None): return Cursor(self, query or {}, projection)

    async def _rows(self, query, projection=None):
        rows = [self.db._merge_legacy(r) for r in await self.db._select(self.name)]
        return [self.db._project(r, projection) for r in rows if self.db.matches(r, query)]

    async def find_one(self, query=None, projection=None, sort=None):
        c = self.find(query, projection)
        if sort: c.sort(sort)
        rows = await c.to_list(1)
        return rows[0] if rows else None

    async def insert_one(self, doc): await self.db._insert(self.name, doc); return Result(1, 1)

    async def insert_many(self, docs):
        docs = list(docs)
        if docs: await self.db._insert(self.name, docs)
        return Result(len(docs), len(docs))

    async def update_one(self, query, update, upsert=False):
        rows = await self._rows(query)
        if not rows:
            if not upsert: return Result()
            base = {k:v for k,v in query.items() if not k.startswith("$") and not isinstance(v, dict)}
            await self.db._insert(self.name, self.db.apply_update(base, update))
            return Result(0, 1)
        old = rows[0]; new = self.db.apply_update(copy.deepcopy(old), update)
        await self.db._replace(self.name, old, new)
        return Result(1, 1)

    async def update_many(self, query, update):
        rows = await self._rows(query)
        for old in rows: await self.db._replace(self.name, old, self.db.apply_update(copy.deepcopy(old), update))
        return Result(len(rows), len(rows))

    async def delete_many(self, query):
        rows = await self._rows(query)
        for row in rows: await self.db._delete(self.name, row)
        return Result(deleted_count=len(rows))

    async def delete_one(self, query):
        rows = await self._rows(query)
        if not rows: return Result()
        await self.db._delete(self.name, rows[0]); return Result(deleted_count=1)

    async def count_documents(self, query=None): return len(await self._rows(query or {}))

    async def find_one_and_update(self, query, update, projection=None, sort=None, return_document=None):
        c = self.find(query)
        if sort: c.sort(sort)
        rows = await c.to_list(1)
        if not rows: return None
        old = rows[0]; new = self.db.apply_update(copy.deepcopy(old), update)
        await self.db._replace(self.name, old, new)
        return self.db._project(new if return_document else old, projection)


class SupabaseDatabase:
    TABLES = {
        "users":"profiles","attendance":"attendance","offices":"offices","schedule":"schedule",
        "holidays":"holidays","overtime_requests":"overtime_requests","leaves":"leaves",
        "admin_requests":"admin_requests","attendance_corrections":"attendance_corrections",
        "notifications":"notifications","push_tokens":"push_tokens","security_audit":"security_audit",
        "security_rate_events":"security_rate_events","auth_failures":"auth_failures",
        "user_sessions":"user_sessions","liveness_sessions":"liveness_sessions","liveness_results":"liveness_results",
    }
    COLUMNS = {
        "profiles":{"id","user_id","email","full_name","name","phone","department","position","role","avatar_url","is_active","profile_completed","created_at","updated_at","legacy_data"},
        "attendance":{"id","attendance_id","user_id","user_email","user_name","department","date","action","office_id","office_name","distance_meters","verification","photo_url","created_at","corrected_by","correction_id","legacy_data"},
        "offices":{"id","office_id","name","address","latitude","longitude","radius_meters","is_active","created_at","updated_at","legacy_data"},
        "schedule":{"id","schedule_id","check_in","check_out","break_start","break_end","grace_minutes","monday","tuesday","wednesday","thursday","friday","saturday","sunday","created_at","updated_at","legacy_data"},
        "holidays":{"id","holiday_id","date","name","created_at","legacy_data"},
        "overtime_requests":{"id","request_id","user_id","user_name","user_email","department","date","reason","status","approved_by","approved_at","created_at","updated_at","legacy_data"},
        "leaves":{"id","leave_id","user_id","user_name","user_email","department","leave_type","start_date","end_date","reason","status","approved_by","approved_at","created_at","updated_at","legacy_data"},
        "admin_requests":{"id","request_id","user_id","user_name","user_email","reason","status","reviewed_by","reviewed_at","created_at","legacy_data"},
        "attendance_corrections":{"id","correction_id","user_id","user_name","user_email","department","date","action","requested_time","reason","attachment_url","status","resolved_by","resolved_at","cancelled_at","created_at","legacy_data"},
        "notifications":{"id","notification_id","user_id","title","message","notification_type","reference_id","read","read_at","created_at","legacy_data"},
        "push_tokens":{"id","user_id","platform","device_token","is_active","created_at","updated_at","legacy_data"},
        "security_audit":{"id","audit_id","user_id","event","outcome","metadata","created_at","legacy_data"},
        "security_rate_events":{"id","user_id","action","created_at","expires_at","legacy_data"},
        "auth_failures":{"id","user_id","purpose","created_at","expires_at","legacy_data"},
        "user_sessions":{"id","session_id","user_id","created_at","expires_at","revoked_at","legacy_data"},
        "liveness_sessions":{"id","session_id","user_id","challenge","status","expires_at","created_at","legacy_data"},
        "liveness_results":{"id","result_id","session_id","user_id","attendance_id","verified","score","details","created_at","legacy_data"},
    }
    LEGACY = "app_documents"

    def __init__(self, url, key):
        self.url=url.rstrip("/"); self.key=key
        self.client=httpx.AsyncClient(timeout=httpx.Timeout(30, connect=10), headers={"apikey":key,"Content-Type":"application/json"})

    def __getattr__(self, name):
        if name.startswith("_"): raise AttributeError(name)
        return Table(self, name)

    def _table(self, name): return self.TABLES.get(name, self.LEGACY)
    def _legacy(self, name): return name not in self.TABLES

    async def _request(self, method, table, params=None, json=None, prefer=None):
        headers={"Prefer":prefer} if prefer else None
        r=await self.client.request(method, f"{self.url}/rest/v1/{table}", params=params, json=json, headers=headers)
        if r.status_code>=400: raise RuntimeError(f"Supabase {method} {table} failed ({r.status_code}): {r.text[:1200]}")
        if not r.content: return []
        data=r.json()
        return [_restore(x) for x in data] if isinstance(data,list) else [_restore(data)]

    async def _select(self, name):
        if self._legacy(name):
            rows=await self._request("GET",self.LEGACY,{"select":"id,collection,document,created_at,updated_at"})
            return [{**(r.get("document") or {}),"_legacy_id":r["id"]} for r in rows if r.get("collection")==name]
        rows=await self._request("GET",self._table(name),{"select":"*"})
        if name=="users": return [self._from_profile(r) for r in rows]
        return rows

    def _merge_legacy(self,row):
        extra=row.get("legacy_data")
        if isinstance(extra,dict): return {**extra,**row}
        return row

    async def _insert(self,name,docs):
        docs=docs if isinstance(docs,list) else [docs]
        if self._legacy(name):
            await self._request("POST",self.LEGACY,{"select":"id"},[{"collection":name,"document":_json({k:v for k,v in d.items() if k!="_legacy_id"})} for d in docs],"return=minimal")
            return
        await self._request("POST",self._table(name),{"select":"*"},[self._to_row(name,d) for d in docs])

    async def _replace(self,name,old,new):
        if self._legacy(name):
            await self._request("PATCH",self.LEGACY,{"id":f"eq.{old.get('_legacy_id')}"},{"document":_json({k:v for k,v in new.items() if k!="_legacy_id"})},"return=minimal"); return
        ro,rn=self._to_row(name,old),self._to_row(name,new)
        key=self._key(name,ro)
        patch={k:v for k,v in rn.items() if ro.get(k)!=v}
        if patch: await self._request("PATCH",self._table(name),key,patch,"return=minimal")

    async def _delete(self,name,row):
        if self._legacy(name):
            await self._request("DELETE",self.LEGACY,{"id":f"eq.{row.get('_legacy_id')}"},None,"return=minimal"); return
        key=self._key(name,self._to_row(name,row))
        if key: await self._request("DELETE",self._table(name),key,None,"return=minimal")

    def _key(self,name,row):
        field={"users":"user_id","attendance":"attendance_id","offices":"office_id","schedule":"schedule_id","holidays":"holiday_id","overtime_requests":"request_id","leaves":"leave_id","admin_requests":"request_id","attendance_corrections":"correction_id","notifications":"notification_id","security_audit":"audit_id","user_sessions":"session_id","liveness_sessions":"session_id","liveness_results":"result_id"}.get(name,"id")
        return {field:f"eq.{row[field]}"} if row.get(field) is not None else {}

    def _to_row(self,name,doc):
        doc={k:v for k,v in doc.items() if k!="_legacy_id"}
        if name=="users":
            reserved={"id","supabase_user_id","user_id","email","full_name","name","phone","department","position","role","avatar_url","is_active","account_status","profile_completed","profile_complete","created_at","updated_at"}
            return {k:_json(v) for k,v in {
                "id":doc.get("supabase_user_id") or doc.get("id"),"user_id":doc.get("user_id"),"email":doc.get("email"),
                "full_name":doc.get("full_name") or doc.get("name"),"name":doc.get("name"),"phone":doc.get("phone"),
                "department":doc.get("department"),"position":doc.get("position"),"role":doc.get("role","employee"),
                "avatar_url":doc.get("avatar_url"),"is_active":doc.get("is_active",doc.get("account_status","approved")=="approved"),
                "profile_completed":doc.get("profile_completed",doc.get("profile_complete",False)),
                "created_at":doc.get("created_at"),"updated_at":doc.get("updated_at"),
                "legacy_data":{k:v for k,v in doc.items() if k not in reserved}
            }.items() if v is not None}
        known=self.COLUMNS[self._table(name)]
        row={}; extra={}
        for k,v in doc.items():
            if k in known and k!="id": row[k]=_json(v)
            elif k!="id": extra[k]=v
        if "id" in known and doc.get("id"): row["id"]=doc["id"]
        row["legacy_data"]=_json({**(doc.get("legacy_data") if isinstance(doc.get("legacy_data"),dict) else {}),**extra})
        return row

    def _from_profile(self,row):
        extra=row.get("legacy_data") if isinstance(row.get("legacy_data"),dict) else {}
        d={**extra,**{k:v for k,v in row.items() if k!="legacy_data"}}
        if row.get("id"): d.setdefault("supabase_user_id",row["id"])
        if row.get("full_name"): d.setdefault("name",row["full_name"])
        if "profile_completed" in row: d["profile_complete"]=row["profile_completed"]
        if "is_active" in row: d.setdefault("account_status","approved" if row["is_active"] else "rejected")
        return d

    @staticmethod
    def _project(row,p):
        if not p: return row
        inc=[k for k,v in p.items() if v and k!="_id"]; exc=[k for k,v in p.items() if not v]
        out={k:row[k] for k in inc if k in row} if inc else dict(row)
        for k in exc: out.pop(k,None)
        out.pop("_id",None); return out

    @classmethod
    def matches(cls,row,q):
        for k,e in q.items():
            if k=="$or" and not any(cls.matches(row,x) for x in e): return False
            if k=="$and" and not all(cls.matches(row,x) for x in e): return False
            if k.startswith("$"): continue
            a=row.get(k)
            if isinstance(e,dict):
                for op,v in e.items():
                    if op=="$in" and a not in v:return False
                    if op=="$nin" and a in v:return False
                    if op=="$ne" and a==v:return False
                    if op=="$exists" and ((k in row)!=bool(v)):return False
                    if op=="$gte" and not(a is not None and a>=v):return False
                    if op=="$gt" and not(a is not None and a>v):return False
                    if op=="$lte" and not(a is not None and a<=v):return False
                    if op=="$lt" and not(a is not None and a<v):return False
                    if op=="$regex" and (a is None or re.search(str(v),str(a)) is None):return False
            elif a!=e:return False
        return True

    @staticmethod
    def apply_update(doc,u):
        if not any(k.startswith("$") for k in u): return dict(u)
        for op,vals in u.items():
            if op=="$set": doc.update(vals)
            elif op=="$unset":
                for k in vals: doc.pop(k,None)
            elif op=="$inc":
                for k,v in vals.items(): doc[k]=(doc.get(k) or 0)+v
            elif op=="$setOnInsert":
                for k,v in vals.items(): doc.setdefault(k,v)
        return doc

    async def close(self): await self.client.aclose()
