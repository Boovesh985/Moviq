"""Offline evaluation of the recommender on real people (MovieLens raters + Moviq members).

Temporal hold-out: each person's most recent 20% of ratings are hidden, the model is rebuilt on
everything before, and we check how many films they rated ≥ 4★ come back in their top 10.
Blend weights are learned on half the people and scored on the other half.

    .venv/Scripts/python evaluate.py
"""
from recommender import Recommender

NAMES = {"crowd": "Popularity baseline", "content": "Content only", "collab": "Item-item CF only",
         "latent": "PureSVD only", "current": "Hand-set weights", "tuned": "Learned blend"}


def main():
    result = Recommender().tune()
    test = result["test"]
    print(f"{result['people']} people, {result['hidden_ratings']} hidden ratings; scored on {test['tuned']['users']} people not used for tuning\n")
    print(f"{'model':<22}{'recall@10':>11}{'nDCG@10':>10}")
    for key in ("crowd", "content", "collab", "latent", "current", "tuned"):
        print(f"{NAMES[key]:<22}{test[key]['recall@10']:>11.4f}{test[key]['ndcg@10']:>10.4f}")
    for src, m in test.get("by_source", {}).items():
        print(f"  {src + ' members':<20}{m['tuned']['recall@10']:>11.4f}{m['tuned']['ndcg@10']:>10.4f}"
              f"   ({m['tuned']['users']} people; popularity {m['popularity']['recall@10']:.4f})")
    print(f"\nlearned weights: {result['weights']}")
    lift = test["tuned"]["recall@10"] / max(test["crowd"]["recall@10"], 1e-9)
    print(f"learned blend vs popularity: {lift:.2f}x recall@10")


if __name__ == "__main__":
    main()
