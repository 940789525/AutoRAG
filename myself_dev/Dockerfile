# Derived from scripts/ci/qa.Dockerfile; keep tool versions/checksums aligned.
FROM node:24-bookworm AS node
FROM oven/bun:1.4.2 AS bun
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# HTTPS avoids the host network's failing HTTP package gateway.
COPY --from=node /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources \
    && printf 'Acquire::Retries "5";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80-dev-retries

RUN apt-get update \
	&& apt-get install --no-install-recommends --yes bash ca-certificates git tar \
	&& rm -rf /var/lib/apt/lists/*

ARG TARGETARCH

# AutoRAG's optional Korean BM25 tokenizer loads the Kiwi native library and base model at run time, and AutoRAG selects it
# only when both exist. They are pinned and verified here so the live E2E exercises Korean tokenization for real
# instead of reporting a whitespace fallback. curl is installed only for this step.
RUN set -eu; \
	case "${TARGETARCH:-amd64}" in \
		amd64) kiwi_arch=x86_64; kiwi_sha=a1d34a6340215a6c325bb0d2c445e5245323a1ec4ec362ed3cab36dbe11309eb ;; \
		arm64) kiwi_arch=aarch64; kiwi_sha=80731c5c29049dbf039787092bed50cd600a599db9b070f8c0d7b5cf2276b739 ;; \
		*) echo "no pinned Kiwi build for ${TARGETARCH}" >&2; exit 1 ;; \
	esac; \
	base=https://github.com/bab2min/Kiwi/releases/download/v0.22.2; \
	apt-get update; \
	apt-get install --no-install-recommends --yes curl; \
	mkdir -p /opt/kiwi /tmp/kiwi; \
	curl --retry 5 --retry-all-errors --connect-timeout 20 --max-time 300 -fsSL -o /tmp/kiwi/lib.tgz "$base/kiwi_lnx_${kiwi_arch}_v0.22.2.tgz"; \
	curl --retry 5 --retry-all-errors --connect-timeout 20 --max-time 300 -fsSL -o /tmp/kiwi/model.tgz "$base/kiwi_model_v0.22.2_base.tgz"; \
	echo "${kiwi_sha}  /tmp/kiwi/lib.tgz" | sha256sum -c -; \
	echo "aa11a6e5b06c7db43e9b07148620f5fb7838a30172dacb40f75202333110f2d1  /tmp/kiwi/model.tgz" | sha256sum -c -; \
	tar -xzf /tmp/kiwi/lib.tgz -C /opt/kiwi lib; \
	tar -xzf /tmp/kiwi/model.tgz -C /opt/kiwi models; \
	apt-get purge --yes --auto-remove curl; \
	rm -rf /tmp/kiwi /var/lib/apt/lists/*

ENV KIWI_LIBRARY_PATH=/opt/kiwi/lib/libkiwi.so \
	KIWI_MODEL_PATH=/opt/kiwi/models/cong/base

# CPU embedding runtime; models are prepared explicitly into an isolated persistent cache.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes python3 python3-venv \
    && python3 -m venv /opt/autorag-embedding \
    && rm -rf /var/lib/apt/lists/*
COPY src/embedding/embedding-requirements.lock /opt/autorag-embedding/requirements.lock
RUN /opt/autorag-embedding/bin/pip install --no-cache-dir --require-hashes -r /opt/autorag-embedding/requirements.lock
ENV AUTORAG_FASTEMBED_PYTHON=/opt/autorag-embedding/bin/python

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
	&& ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN mkdir -p /dev-home/.cache /data/workspace /workspace/node_modules /workspace/dist \
    && chown -R 1000:1000 /dev-home /data /workspace
USER 1000:1000
WORKDIR /workspace

CMD ["bash"]
