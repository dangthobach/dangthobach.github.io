---
Created by: Bách Đặng Thọ
Created time: 2024-02-16T00:40
tags:
  - Database
---
# **Lightning Fast SQL with Real Time Materialized Views**

Materialized views (MVs) can give amazing performance boost. Once you create one based on your query, Oracle can get the results direct from the MV instead of executing the statement itself. This can make SQL significantly faster. Especially when the query processes millions of rows but there are only a handful in the output.

There's just one problem.

The data in the MV has to be fresh. Otherwise Oracle won't do the rewrite.

You could of course query the MV directly. But the data will still be old.

So you need to keep the materialized view up-to-date. The easiest way is to declare it as "fast refresh on commit".

But this is easier said than done. Doing this has a couple of issues:

- Only some queries support on commit refreshes

- Oracle Database [serializes MV refreshes](http://rwijk.blogspot.co.uk/2010/01/enq-ji-contention.html)

So if you have complex SQL you may not be able to use query rewrite. And even if you can, on high transaction systems the refresh overhead may cripple your system.

So instead of "fast refresh on commit", you make the MV "fast refresh on demand". And create a job to update it. Which runs every second!

But no matter how frequently you run the job, there will always be times when the MV is stale. So query performance could switch between lightning fast and dog slow. A guaranteed way to upset your users!

So how do you overcome this?

With real time materialized views!

These give the best of both worlds. You can refresh your MV on demand. But still have it return up-to-date information.

To do this, create the MV with the clause:

on query computation

For example:

[Copy code snippet](https://blogs.oracle.com/sql/post/12-things-developers-will-love-about-oracle-database-12c-release-2#copy)

Copied to Clipboard

Error: Could not Copy

Copied to Clipboard

Error: Could not Copy

```Plain
create table t (x not null primary key, y not null) as
  select rownum x, mod(rownum, 10) y from dual connect by level <= 1000;

create materialized view log on t with rowid (x, y) including new values;

create materialized view mv
refresh fast on demand
enable on query computation
enable query rewrite
as
  select y , count(*) c1
  from t
  group by y;
```

With this, you can add more data to your table:

insert into t

[Copy code snippet](https://blogs.oracle.com/sql/post/12-things-developers-will-love-about-oracle-database-12c-release-2#copy)

Copied to Clipboard

Error: Could not Copy

Copied to Clipboard

Error: Could not Copy

```Plain
insert into t
  select 1000+rownum, 1 from dual connect by level <= 100;

commit;
```

And Oracle can still use the MV to rewrite. _Even though the MV is stale_!

[Copy code snippet](https://blogs.oracle.com/sql/post/12-things-developers-will-love-about-oracle-database-12c-release-2#copy)

Copied to Clipboard

Error: Could not Copy

Copied to Clipboard

Error: Could not Copy

```Plain
select /*+ rewrite */y , count(*) from t
group by y;
```

It does this by:

- Querying the stale MV

- Then applying the inserts, updates and deletes in the MV log to it

This can lead to some scary looking execution plans!

[![](https://blogs.oracle.com/content/published/api/v1.1/assets/CONTB21CC65BDDA94E2D80C2600D8278B44A/Medium?cb=_cache_5655&channelToken=6cfdb5758b544e9d97eea1b8b7eeb273&format=jpg)](https://blogs.oracle.com/content/published/api/v1.1/assets/CONTB21CC65BDDA94E2D80C2600D8278B44A/Medium?cb=_cache_5655&channelToken=6cfdb5758b544e9d97eea1b8b7eeb273&format=jpg)

The point to remember is Oracle is reading the materialized view log. Then applying the changes to the MV. So the longer you leave it between refreshes, the more data there will be. You'll need to test to find the sweet spot to balancing the refresh process and applying MV change logs on query rewrite.

You can even get the up-to-date information when you query the MV directly. To do so, add the fresh_mv hint:

[Copy code snippet](https://blogs.oracle.com/sql/post/12-things-developers-will-love-about-oracle-database-12c-release-2#copy)

Copied to Clipboard

Error: Could not Copy

Copied to Clipboard

Error: Could not Copy

```Plain
select /*+ fresh_mv */* from mv; <span> </span>
```

The really cool part?

You can convert your existing MVs to real time with the following command:

[Copy code snippet](https://blogs.oracle.com/sql/post/12-things-developers-will-love-about-oracle-database-12c-release-2#copy)

Copied to Clipboard

Error: Could not Copy

Copied to Clipboard

Error: Could not Copy

```Plain
alter materialized view mv enable on query computation;
```

This makes MVs much easier to work with, opening up your querying tuning options!